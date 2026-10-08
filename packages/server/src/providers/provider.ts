/**
 * A decision provider answers a battery of questions about one comment. Jev, Laya,
 * Llama Guard and the stage-2 LLM all sit behind this interface; the pipeline never
 * knows which model it is talking to.
 */

import type { Answers, Battery, Usage } from '@kommentarwache/contract';
import type { CommentContext, ProviderKind } from '../db/types.js';

export interface ModerationInput {
  text: string;
  context?: CommentContext;
}

export interface AssessOutcome {
  status: 'ok' | 'error' | 'timeout';
  answers?: Answers;
  modelVersion?: string;
  usage?: Usage;
  costUsd?: number;
  latencyMs: number;
  /** the full provider response, for debugging */
  raw?: Record<string, unknown>;
  error?: string;
}

export interface DecisionProvider {
  /** the provider_configs row this instance was built from */
  readonly configId: number;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly battery: Battery;
  assess(input: ModerationInput): Promise<AssessOutcome>;
}

/**
 * Only the comment and its thread context go to a model. Author names and IDs never
 * do; that is a rule of the project, not a convenience.
 */
export function buildState(input: ModerationInput): Record<string, unknown> {
  const state: Record<string, unknown> = { comment: input.text };
  if (input.context && Object.keys(input.context).length > 0) state['context'] = input.context;
  return state;
}
