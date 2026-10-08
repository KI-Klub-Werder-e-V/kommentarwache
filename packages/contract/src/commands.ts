/**
 * The command catalogue: every operation an agent or the API can perform, with its
 * input schema, the scope it needs and its REST binding. The server implements each
 * one once; the REST routes and the MCP tools are generated from this list, so
 * anything a moderator can do, an agent can do, and the parity test checks it.
 */

import { z } from 'zod';
import { CategorySchema, VerdictSchema } from './verdict.js';
import { ModerateRequestSchema } from './moderate.js';

export const ScopeSchema = z.enum(['moderate', 'review', 'actions', 'admin']);
export type Scope = z.infer<typeof ScopeSchema>;

export interface CommandSpec<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  scope: Scope;
  method: 'GET' | 'POST' | 'PUT';
  /** REST path; `:id` params are read from the input of the same name */
  path: string;
  input: I;
  /** true when the command changes state; MCP marks such tools as non read-only */
  mutating: boolean;
}

const id = z.number().int().positive().describe('comment id');

export const COMMANDS = {
  moderate_comment: {
    name: 'moderate_comment',
    description:
      'Submit one comment for moderation and get the stage-1 verdict at once. Idempotent on (source, id). Unsure comments continue to stage 2 and, if still unsure, to a human.',
    scope: 'moderate',
    method: 'POST',
    path: '/v1/moderate',
    input: ModerateRequestSchema,
    mutating: true,
  },
  list_queue: {
    name: 'list_queue',
    description:
      'The open review queue: comments both models left unsure, disputed stage-1 flags, proposed actions, failures.',
    scope: 'review',
    method: 'GET',
    path: '/v1/queue',
    input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
    mutating: false,
  },
  get_comment: {
    name: 'get_comment',
    description:
      'One comment with its full timeline: assessments with probabilities, decisions, actions, labels.',
    scope: 'review',
    method: 'GET',
    path: '/v1/comments/:id',
    input: z.object({ id }),
    mutating: false,
  },
  decide_comment: {
    name: 'decide_comment',
    description:
      'Record a human-level decision on a comment (ok or violation with a category), resolve its queue item and let the ladder act (hide, or undo a hide). Logged under your token.',
    scope: 'review',
    method: 'POST',
    path: '/v1/comments/:id/decide',
    input: z.object({
      id,
      verdict: VerdictSchema.exclude(['unsure']),
      category: CategorySchema.default('none'),
      note: z.string().max(2000).optional(),
    }),
    mutating: true,
  },
  act_on_comment: {
    name: 'act_on_comment',
    description:
      'A platform action on a comment: hide, delete or ban the author, execute a proposed action (execute:<actionId>) or undo a hide or ban (undo:<actionId>). Without the actions scope, delete and ban become proposals for a moderator.',
    scope: 'review',
    method: 'POST',
    path: '/v1/comments/:id/actions',
    input: z.object({
      id,
      op: z.string().regex(/^(hide|delete|ban|execute:\d+|undo:\d+)$/),
      note: z.string().max(2000).optional(),
    }),
    mutating: true,
  },
  list_log: {
    name: 'list_log',
    description: 'Recent decisions by any stage, newest first, with optional filters.',
    scope: 'review',
    method: 'GET',
    path: '/v1/log',
    input: z.object({
      stage: z.enum(['s1', 's2', 'human']).optional(),
      verdict: VerdictSchema.optional(),
      source: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    mutating: false,
  },
  get_analytics: {
    name: 'get_analytics',
    description:
      'Counts over a window: ingested, flagged per stage, verdicts changed by stage 2, human share and overrides, open queue by reason, per-day rows, provider latency and cost.',
    scope: 'review',
    method: 'GET',
    path: '/v1/analytics',
    input: z.object({ days: z.number().int().min(1).max(365).default(7) }),
    mutating: false,
  },
  get_policy: {
    name: 'get_policy',
    description:
      'The active policy: thresholds, stage-2 wording and examples, action ladder lists.',
    scope: 'review',
    method: 'GET',
    path: '/v1/policy',
    input: z.object({}),
    mutating: false,
  },
  replay_policy: {
    name: 'replay_policy',
    description:
      "What a named policy would have decided over a source's stored answers, without calling a model: verdict counts and agreement with labels. Use before changing thresholds.",
    scope: 'review',
    method: 'POST',
    path: '/v1/policy/replay',
    input: z.object({ source: z.string(), policy: z.string() }),
    mutating: false,
  },
  list_sources: {
    name: 'list_sources',
    description: 'Sources (connectors) with their kind, comment count and action modes.',
    scope: 'review',
    method: 'GET',
    path: '/v1/sources',
    input: z.object({}),
    mutating: false,
  },
  set_source_modes: {
    name: 'set_source_modes',
    description:
      'Set how far a source may act on its own: off, dry_run, propose or auto per action type, plus an hourly cap.',
    scope: 'admin',
    method: 'PUT',
    path: '/v1/sources/:id/modes',
    input: z.object({
      id: z.number().int().positive().describe('source id'),
      hide: z.enum(['off', 'dry_run', 'propose', 'auto']),
      delete: z.enum(['off', 'dry_run', 'propose', 'auto']),
      ban: z.enum(['off', 'dry_run', 'propose', 'auto']),
      max_per_hour: z.number().int().positive().nullable().default(null),
    }),
    mutating: true,
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;
export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];
