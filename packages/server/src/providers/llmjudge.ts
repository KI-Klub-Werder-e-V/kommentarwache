/**
 * Stage 2: a general text LLM through Ollama's chat API with a JSON schema, so the
 * answer is always well-formed. Confidence is read from the log-probabilities of the
 * verdict token when Ollama returns them (0.12.11 or newer), and only otherwise from the
 * model's own estimate, which is known to be flattering.
 */

import {
  CategorySchema,
  VerdictSchema,
  type Answers,
  type Category,
  type CommentContext,
  type Stage2Policy,
  type Verdict,
} from '@kommentarwache/contract';
import { z } from 'zod';

export interface JudgeInput {
  text: string;
  context?: CommentContext | undefined;
  policy: Stage2Policy;
}

export interface JudgeOutcome {
  status: 'ok' | 'error' | 'timeout';
  verdict?: Verdict;
  category?: Category;
  /** P(verdict) over ok / unsure / violation */
  probabilities?: Record<Verdict, number>;
  confidenceSource?: 'logprobs' | 'self';
  rationale?: string;
  /** the verdict as a choice answer, so it is stored like any other assessment */
  answers?: Answers;
  modelVersion?: string;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  raw?: Record<string, unknown>;
  error?: string;
}

export interface JudgeProvider {
  readonly configId: number;
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeOutcome>;
}

const JudgeAnswer = z.object({
  verdict: VerdictSchema,
  category: CategorySchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export const JUDGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'unsure', 'violation'] },
    category: { type: 'string', enum: CategorySchema.options },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['verdict', 'category', 'confidence', 'rationale'],
} as const;

interface LogprobToken {
  token: string;
  logprob: number;
  top_logprobs?: Array<{ token: string; logprob: number }>;
}

export function buildMessages(
  input: JudgeInput,
): Array<{ role: 'system' | 'user'; content: string }> {
  const examples = input.policy.examples
    .map(
      (e, i) =>
        `${i + 1}. "${e.text}"\n   verdict: ${e.verdict}, category: ${e.category}. ${e.why}`,
    )
    .join('\n');
  const system =
    `${input.policy.policyText}\n\n` +
    `Categories: none (with ok), rude, harassment, hate, threat, doxxing, spam, scam, other.\n\n` +
    (examples ? `Examples:\n${examples}\n\n` : '') +
    `Answer only with JSON: {"verdict": "ok" | "unsure" | "violation", "category": ..., "confidence": 0 to 1, "rationale": one sentence}.`;

  const ctx = input.context ?? {};
  const lines: string[] = [];
  if (ctx.platform) lines.push(`Platform: ${ctx.platform}`);
  if (ctx.post) lines.push(`The post being commented on: ${ctx.post}`);
  if (ctx.parent_comment) lines.push(`The comment this replies to: ${ctx.parent_comment}`);
  if (ctx.comment_kind) lines.push(`Kind: ${ctx.comment_kind}`);
  lines.push(`Comment to judge:\n"""\n${input.text}\n"""`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * P(verdict) from the top log-probabilities at the token where the verdict value begins.
 * The JSON grammar leaves only the enum alternatives there, so their mass is comparable.
 * Returns undefined when the token cannot be located.
 */
export function verdictProbabilities(
  content: string,
  tokens: LogprobToken[],
  chosen: Verdict,
): Record<Verdict, number> | undefined {
  const m = /"verdict"\s*:\s*"/.exec(content);
  if (!m) return undefined;
  const valueOffset = m.index + m[0].length;
  // The first token at or after the value start that carries text beyond quotes and
  // colons is where the enum alternatives compete.
  let cursor = 0;
  let at: LogprobToken | undefined;
  for (const t of tokens) {
    const end = cursor + t.token.length;
    cursor = end;
    if (end <= valueOffset) continue;
    if (t.token.replace(/^["\s:]+/, '').length > 0) {
      at = t;
      break;
    }
  }
  if (!at) return undefined;
  const candidates = [...(at.top_logprobs ?? []), { token: at.token, logprob: at.logprob }];
  const mass: Record<Verdict, number> = { ok: 0, unsure: 0, violation: 0 };
  const seen = new Set<string>();
  for (const c of candidates) {
    const text = c.token.replace(/^["\s:]+/, '').toLowerCase();
    if (!text || seen.has(c.token)) continue;
    seen.add(c.token);
    const v = (['ok', 'unsure', 'violation'] as const).find(
      (name) => name.startsWith(text) || text.startsWith(name),
    );
    if (v) mass[v] += Math.exp(c.logprob);
  }
  const total = mass.ok + mass.unsure + mass.violation;
  if (total <= 0 || mass[chosen] <= 0) return undefined;
  return { ok: mass.ok / total, unsure: mass.unsure / total, violation: mass.violation / total };
}

export interface OllamaJudgeOptions {
  configId: number;
  name: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  numCtx?: number;
  fetch?: typeof fetch;
}

export class OllamaJudgeProvider implements JudgeProvider {
  readonly configId: number;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly numCtx: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaJudgeOptions) {
    this.configId = opts.configId;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.numCtx = opts.numCtx ?? 4096;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async judge(input: JudgeInput): Promise<JudgeOutcome> {
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: buildMessages(input),
          stream: false,
          think: false,
          format: JUDGE_JSON_SCHEMA,
          options: { temperature: 0, num_ctx: this.numCtx },
          logprobs: true,
          top_logprobs: 5,
          keep_alive: '30m',
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          status: 'error',
          latencyMs: latency(),
          error: `${res.status} from ${this.baseUrl}: ${text.slice(0, 300)}`,
        };
      }
      const raw = (await res.json()) as Record<string, unknown>;
      const content = String((raw['message'] as { content?: unknown } | undefined)?.content ?? '');
      const parsed = JudgeAnswer.safeParse(JSON.parse(content));
      if (!parsed.success) {
        return {
          status: 'error',
          latencyMs: latency(),
          raw,
          error: `judge answer not in schema: ${parsed.error.message}`,
        };
      }
      const a = parsed.data;
      const tokens = Array.isArray(raw['logprobs'])
        ? (raw['logprobs'] as LogprobToken[])
        : undefined;
      const fromLogprobs = tokens ? verdictProbabilities(content, tokens, a.verdict) : undefined;
      const probabilities = fromLogprobs ?? selfProbabilities(a.verdict, a.confidence);
      return {
        status: 'ok',
        verdict: a.verdict,
        category: a.category,
        probabilities,
        confidenceSource: fromLogprobs ? 'logprobs' : 'self',
        rationale: a.rationale,
        answers: {
          verdict: {
            type: 'choice',
            choice: a.verdict,
            probabilities,
            confidence: (probabilities[a.verdict] - 1 / 3) / (1 - 1 / 3),
          },
          category: {
            type: 'choice',
            choice: a.category,
            probabilities: { [a.category]: 1 },
            confidence: 1,
          },
        },
        modelVersion: typeof raw['model'] === 'string' ? raw['model'] : this.model,
        usage: {
          input_tokens: Number(raw['prompt_eval_count'] ?? 0),
          output_tokens: Number(raw['eval_count'] ?? 0),
        },
        latencyMs: latency(),
        raw,
      };
    } catch (err) {
      const name = (err as Error).name;
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: name === 'TimeoutError' ? 'timeout' : 'error',
        latencyMs: latency(),
        error: `${name === 'TimeoutError' ? 'timeout' : 'error'} calling ${this.baseUrl}: ${message}`,
      };
    }
  }
}

/** Without log-probabilities, spread the model's own confidence over the alternatives. */
function selfProbabilities(verdict: Verdict, confidence: number): Record<Verdict, number> {
  const rest = (1 - confidence) / 2;
  return { ok: rest, unsure: rest, violation: rest, [verdict]: confidence };
}
