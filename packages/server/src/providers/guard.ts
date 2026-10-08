/**
 * Llama Guard 3 through Ollama as a stage-1 member. The prompt is written raw with our
 * own four categories (Ollama's template hard-codes Meta's taxonomy), and P(unsafe) is
 * read from the log-probabilities of the first answer token rather than from the word.
 * Answers are normalised to the System One shape so they are stored like any other.
 */

import type { Answers } from '@kommentarwache/contract';
import {
  buildState,
  type AssessOutcome,
  type DecisionProvider,
  type ModerationInput,
} from './provider.js';

export const GUARD_CATEGORIES: Record<string, { label: string; description: string }> = {
  S1: {
    label: 'harassment',
    description:
      'Harassment or personal abuse: insulting, demeaning, mocking or sexually harassing a specific person, including the post author, another commenter or a public figure. Blunt criticism of ideas, products or decisions is not abuse.',
  },
  S2: {
    label: 'hate',
    description:
      'Hate: slurs, dehumanising language or generalised attacks against a group defined by nationality, ethnicity, religion, gender, sexuality, disability, age or similar.',
  },
  S3: {
    label: 'threat',
    description:
      "Threats and doxxing: a threat of violence, wishing someone harm or death, incitement, or publishing someone's private information such as an address.",
  },
  S4: {
    label: 'spam',
    description:
      'Spam and scams: promotional or repetitive solicitation, bare links with no substance, "check out my channel", get-rich schemes, phishing, impersonation, deceptive offers.',
  },
};

export function buildGuardPrompt(input: ModerationInput): string {
  const state = buildState(input);
  const categories = Object.entries(GUARD_CATEGORIES)
    .map(([code, c]) => `${code}: ${c.description}`)
    .join('\n');
  const conversation = JSON.stringify(state, null, 0);
  return (
    '<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\n' +
    "Task: Check if there is unsafe content in 'User' messages in conversations according to our safety policy with the below categories.\n\n" +
    `<BEGIN UNSAFE CONTENT CATEGORIES>\n${categories}\n<END UNSAFE CONTENT CATEGORIES>\n\n` +
    `<BEGIN CONVERSATION>\n\nUser: ${conversation}\n\n<END CONVERSATION>\n\n` +
    'Provide your safety assessment for ONLY THE LAST User message in the above conversation:\n' +
    " - First line must read 'safe' or 'unsafe'.\n" +
    ' - If unsafe, a second line must include a comma-separated list of violated categories.' +
    '<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n'
  );
}

interface LogprobToken {
  token: string;
  logprob: number;
  top_logprobs?: Array<{ token: string; logprob: number }>;
}

/** P(unsafe) from the first token that carries text: mass of "unsafe"-prefixed vs "safe"-prefixed tokens. */
export function unsafeProbability(tokens: LogprobToken[], text: string): number {
  const first = tokens.find((t) => t.token.trim().length > 0);
  if (!first) return /^\s*unsafe/i.test(text) ? 1 : 0;
  const candidates = [
    ...(first.top_logprobs ?? []),
    { token: first.token, logprob: first.logprob },
  ];
  const seen = new Set<string>();
  let safe = 0;
  let unsafe = 0;
  for (const c of candidates) {
    if (seen.has(c.token)) continue;
    seen.add(c.token);
    const t = c.token.trim().toLowerCase();
    if (!t) continue;
    if ('unsafe'.startsWith(t) && t !== 'safe' && t.startsWith('u')) unsafe += Math.exp(c.logprob);
    else if ('safe'.startsWith(t)) safe += Math.exp(c.logprob);
  }
  const total = safe + unsafe;
  if (total === 0) return /^\s*unsafe/i.test(text) ? 1 : 0;
  return unsafe / total;
}

export function parseGuardText(text: string): { unsafe: boolean; categories: string[] } {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim());
  const unsafe = /^unsafe/i.test(lines[0] ?? '');
  const categories = unsafe
    ? (lines[1] ?? '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => c in GUARD_CATEGORIES)
    : [];
  return { unsafe, categories };
}

export interface OllamaGuardOptions {
  configId: number;
  name: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OllamaGuardProvider implements DecisionProvider {
  readonly configId: number;
  readonly name: string;
  readonly kind = 'ollama_guard' as const;
  readonly battery = { name: 'guard', version: 1, questions: {} };
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaGuardOptions) {
    this.configId = opts.configId;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async assess(input: ModerationInput): Promise<AssessOutcome> {
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: buildGuardPrompt(input),
          raw: true,
          stream: false,
          logprobs: true,
          top_logprobs: 5,
          options: { temperature: 0, num_predict: 12 },
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
      const text = String(raw['response'] ?? '');
      const tokens = Array.isArray(raw['logprobs']) ? (raw['logprobs'] as LogprobToken[]) : [];
      const parsed = parseGuardText(text);
      const pUnsafe = unsafeProbability(tokens, text);
      const category = parsed.categories[0] ?? 'none';
      const options = [...Object.keys(GUARD_CATEGORIES), 'none'];
      const answers: Answers = {
        unsafe: { type: 'noul', noul: pUnsafe },
        category: {
          type: 'choice',
          choice: category,
          probabilities: Object.fromEntries(options.map((o) => [o, o === category ? 1 : 0])),
          confidence: 1,
        },
      };
      return {
        status: 'ok',
        answers,
        modelVersion: typeof raw['model'] === 'string' ? raw['model'] : this.model,
        usage: {
          input_tokens: Number(raw['prompt_eval_count'] ?? 0),
          output_tokens: Number(raw['eval_count'] ?? 0),
        },
        costUsd: 0,
        latencyMs: latency(),
        raw: { response: text, categories: parsed.categories },
      };
    } catch (err) {
      const name = (err as Error).name;
      return {
        status: name === 'TimeoutError' ? 'timeout' : 'error',
        latencyMs: latency(),
        error: `${name === 'TimeoutError' ? 'timeout' : 'error'} calling ${this.baseUrl}: ${(err as Error).message}`,
      };
    }
  }
}
