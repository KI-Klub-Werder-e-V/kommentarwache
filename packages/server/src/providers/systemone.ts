/**
 * Client and provider for the System One wire format shared by Jev (api.typesafe.ai)
 * and Laya (laya-serve). Only the base URL, key and model differ.
 */

import { AnswersSchema, UsageSchema, type Battery, type Questions } from '@kommentarwache/contract';
import { z } from 'zod';
import {
  buildState,
  type AssessOutcome,
  type DecisionProvider,
  type ModerationInput,
} from './provider.js';

export const SystemOneResponseSchema = z.object({
  model: z.string(),
  answers: AnswersSchema,
  usage: UsageSchema,
});
export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

export class SystemOneError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SystemOneError';
  }
}

export interface SystemOneClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  /** attempts after the first; 429, 529 and network errors are retried with backoff */
  maxRetries?: number;
  fetch?: typeof fetch;
}

export class SystemOneClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SystemOneClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async systemOne(req: {
    state: unknown;
    model: string;
    questions: Questions;
  }): Promise<{ response: SystemOneResponse; raw: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    const body = JSON.stringify(req);

    let lastError: SystemOneError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt, lastError));
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
          lastError = new SystemOneError(
            `${res.status} from ${this.baseUrl}: ${text.slice(0, 300)}`,
            res.status,
            retryable,
          );
          lastError.retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
          if (!retryable) throw lastError;
          continue;
        }
        const raw = (await res.json()) as Record<string, unknown>;
        const parsed = SystemOneResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new SystemOneError(
            `unexpected response shape: ${parsed.error.message}`,
            res.status,
            false,
          );
        }
        return { response: parsed.data, raw };
      } catch (err) {
        if (err instanceof SystemOneError) {
          if (!err.retryable) throw err;
          lastError = err;
          continue;
        }
        // AbortSignal.timeout rejects with a TimeoutError; network failures are TypeErrors
        const name = (err as Error).name;
        lastError = new SystemOneError(
          `${name === 'TimeoutError' ? 'timeout' : 'network error'} calling ${this.baseUrl}: ${(err as Error).message}`,
          undefined,
          true,
        );
      }
    }
    throw lastError ?? new SystemOneError('request failed', undefined, false);
  }
}

declare module './systemone.js' {
  interface SystemOneError {
    retryAfterMs?: number | undefined;
  }
}

function backoffMs(attempt: number, last: SystemOneError | undefined): number {
  if (last?.retryAfterMs) return last.retryAfterMs;
  const base = 250 * 2 ** (attempt - 1);
  return base + Math.random() * base;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SystemOneProviderOptions {
  configId: number;
  name: string;
  battery: Battery;
  model: string;
  client: SystemOneClient;
  /** dollars per input token; Jev is 42e-9, Laya is 0 */
  costPerInputToken?: number;
  isLocal?: boolean;
}

export class SystemOneProvider implements DecisionProvider {
  readonly configId: number;
  readonly name: string;
  readonly kind = 'systemone' as const;
  readonly battery: Battery;
  private readonly model: string;
  private readonly client: SystemOneClient;
  private readonly costPerInputToken: number;

  constructor(opts: SystemOneProviderOptions) {
    this.configId = opts.configId;
    this.name = opts.name;
    this.battery = opts.battery;
    this.model = opts.model;
    this.client = opts.client;
    this.costPerInputToken = opts.costPerInputToken ?? 0;
  }

  async assess(input: ModerationInput): Promise<AssessOutcome> {
    const started = performance.now();
    try {
      const { response, raw } = await this.client.systemOne({
        state: buildState(input),
        model: this.model,
        questions: this.battery.questions,
      });
      return {
        status: 'ok',
        answers: response.answers,
        modelVersion: response.model,
        usage: response.usage,
        costUsd: response.usage.input_tokens * this.costPerInputToken,
        latencyMs: Math.round(performance.now() - started),
        raw,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: message.startsWith('timeout') ? 'timeout' : 'error',
        latencyMs: Math.round(performance.now() - started),
        error: message,
      };
    }
  }
}

export const JEV_BASE_URL = 'https://api.typesafe.ai';
export const JEV_COST_PER_INPUT_TOKEN = 42 / 1e9;
