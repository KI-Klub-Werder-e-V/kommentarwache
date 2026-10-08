/**
 * OpenAI's moderation endpoint (free, fixed taxonomy, per-category scores, German
 * supported) as a stage-1 member for a parallel or shadow signal. Scores are stored as
 * noul answers per category.
 */

import type { Answers } from '@kommentarwache/contract';
import type { AssessOutcome, DecisionProvider, ModerationInput } from './provider.js';

export const OPENAI_MODERATION_URL = 'https://api.openai.com/v1/moderations';

export interface OpenAIModerationOptions {
  configId: number;
  name: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAIModerationProvider implements DecisionProvider {
  readonly configId: number;
  readonly name: string;
  readonly kind = 'openai_moderation' as const;
  readonly battery = { name: 'openai-moderation', version: 1, questions: {} };
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIModerationOptions) {
    this.configId = opts.configId;
    this.name = opts.name;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'omni-moderation-latest';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async assess(input: ModerationInput): Promise<AssessOutcome> {
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    try {
      // Only the comment text goes out; thread context is not part of this taxonomy.
      const res = await this.fetchImpl(OPENAI_MODERATION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: input.text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          status: 'error',
          latencyMs: latency(),
          error: `${res.status} from OpenAI moderation: ${text.slice(0, 300)}`,
        };
      }
      const raw = (await res.json()) as {
        model?: string;
        results?: Array<{ flagged: boolean; category_scores: Record<string, number> }>;
      };
      const result = raw.results?.[0];
      if (!result)
        return {
          status: 'error',
          latencyMs: latency(),
          error: 'no results in moderation response',
        };
      const answers: Answers = {};
      for (const [category, score] of Object.entries(result.category_scores)) {
        answers[category.replace(/[/-]/g, '_')] = { type: 'noul', noul: score };
      }
      return {
        status: 'ok',
        answers,
        modelVersion: raw.model ?? this.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        costUsd: 0,
        latencyMs: latency(),
        raw: { flagged: result.flagged },
      };
    } catch (err) {
      const name = (err as Error).name;
      return {
        status: name === 'TimeoutError' ? 'timeout' : 'error',
        latencyMs: latency(),
        error: `${name === 'TimeoutError' ? 'timeout' : 'error'} calling OpenAI moderation: ${(err as Error).message}`,
      };
    }
  }
}
