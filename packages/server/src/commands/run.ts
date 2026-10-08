/**
 * One implementation per command in the catalogue. The REST adapter and the MCP server
 * both call `runCommand`, so an agent can do exactly what a moderator can, under the
 * same scopes, and every call is attributed to its token.
 */

import type { Kysely } from 'kysely';
import { COMMANDS, type CommandName } from '@kommentarwache/contract';
import { executeProposed, manualAction, proposeAction, undoAction } from '../actions/engine.js';
import { daily, overview, providerStats } from '../analytics/queries.js';
import { hasScope, type AuthedActor } from '../api/auth.js';
import { moderateComment } from '../api/moderate.js';
import { listSourcesWithModes, setConnectorModes } from '../connectors/modes.js';
import type { DB } from '../db/types.js';
import { replay } from '../eval/run.js';
import { POLICIES } from '../policy/policy.js';
import type { ActivePipeline } from '../providers/registry.js';
import { decideComment } from '../review/decide.js';
import { commentDetail, listLog, listQueue } from '../review/queries.js';

export class CommandError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface CommandContext {
  db: Kysely<DB>;
  pipeline: () => Promise<ActivePipeline>;
  actor: AuthedActor;
  via: 'api' | 'mcp';
}

export async function runCommand(
  name: CommandName,
  ctx: CommandContext,
  rawInput: unknown,
): Promise<unknown> {
  const spec = COMMANDS[name];
  if (!hasScope(ctx.actor, spec.scope))
    throw new CommandError(403, `token lacks scope ${spec.scope}`);
  const parsed = spec.input.safeParse(rawInput ?? {});
  if (!parsed.success)
    throw new CommandError(
      400,
      `invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const input = parsed.data as never;
  const handler = HANDLERS[name] as (ctx: CommandContext, input: never) => Promise<unknown>;
  return handler(ctx, input);
}

type Input<N extends CommandName> = (typeof COMMANDS)[N]['input']['_output'];
type Handlers = { [N in CommandName]: (ctx: CommandContext, input: Input<N>) => Promise<unknown> };

const HANDLERS: Handlers = {
  moderate_comment: async (ctx, input) => moderateComment(ctx.db, await ctx.pipeline(), input),

  list_queue: async (ctx, input) => ({ items: await listQueue(ctx.db, input.limit) }),

  get_comment: async (ctx, input) => {
    const d = await commentDetail(ctx.db, input.id);
    if (!d) throw new CommandError(404, `comment ${input.id} not found`);
    return d;
  },

  decide_comment: async (ctx, input) => {
    const p = await ctx.pipeline();
    return decideComment(
      ctx.db,
      {
        commentId: input.id,
        verdict: input.verdict,
        category: input.category,
        note: input.note,
        actorId: ctx.actor.id,
        via: ctx.via,
      },
      { connectors: p.connectors, secretKey: p.secretKey, policy: p.policy },
    );
  },

  act_on_comment: async (ctx, input) => {
    const p = await ctx.pipeline();
    const engine = { connectors: p.connectors, secretKey: p.secretKey };
    const irreversibleAllowed = hasScope(ctx.actor, 'actions');
    const op = input.op;
    if (op === 'hide' || op === 'delete' || op === 'ban') {
      if (op !== 'hide' && !irreversibleAllowed) {
        const r = await proposeAction(ctx.db, {
          commentId: input.id,
          type: op,
          actorId: ctx.actor.id,
          via: ctx.via,
          note: input.note,
        });
        return {
          ...r,
          proposed: true,
          reason: 'token lacks the actions scope; queued for a moderator',
        };
      }
      return manualAction(ctx.db, engine, {
        commentId: input.id,
        type: op,
        actorId: ctx.actor.id,
        via: ctx.via,
        ...(input.note ? { note: input.note } : {}),
      });
    }
    const actionId = Number(op.split(':')[1]);
    const action = await ctx.db
      .selectFrom('actions')
      .select(['id', 'action_type', 'comment_id'])
      .where('id', '=', actionId)
      .executeTakeFirst();
    if (!action || action.comment_id !== input.id)
      throw new CommandError(404, `action ${actionId} not found on comment ${input.id}`);
    if (op.startsWith('execute:')) {
      if (
        action.action_type !== 'hide' &&
        action.action_type !== 'unhide' &&
        !irreversibleAllowed
      ) {
        throw new CommandError(403, `executing a ${action.action_type} needs the actions scope`);
      }
      return {
        actionId,
        outcome: await executeProposed(ctx.db, engine, actionId, ctx.actor.id, ctx.via),
      };
    }
    return undoAction(ctx.db, engine, actionId, ctx.actor.id, ctx.via);
  },

  list_log: async (ctx, input) => ({ rows: await listLog(ctx.db, input) }),

  get_analytics: async (ctx, input) => {
    const since = new Date(Date.now() - input.days * 86_400_000);
    const [o, rows, providers] = await Promise.all([
      overview(ctx.db, { since }),
      daily(ctx.db, { since }),
      providerStats(ctx.db, { since }),
    ]);
    return { days: input.days, since: since.toISOString(), ...o, daily: rows, providers };
  },

  get_policy: async (ctx) => {
    const p = await ctx.pipeline();
    return {
      pipeline_config_id: p.pipelineConfigId,
      stage1_provider: p.provider.name,
      stage2_provider: p.judge?.name ?? null,
      policy: p.policy,
      known_policies: Object.keys(POLICIES),
    };
  },

  replay_policy: async (ctx, input) => {
    const policy = POLICIES[input.policy];
    if (!policy)
      throw new CommandError(
        400,
        `unknown policy ${input.policy}; known: ${Object.keys(POLICIES).join(', ')}`,
      );
    try {
      return await replay(ctx.db, input.source, policy);
    } catch (err) {
      throw new CommandError(404, (err as Error).message);
    }
  },

  list_sources: async (ctx) => ({ sources: await listSourcesWithModes(ctx.db) }),

  set_source_modes: async (ctx, input) => {
    const exists = await ctx.db
      .selectFrom('connectors')
      .select('id')
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (!exists) throw new CommandError(404, `source ${input.id} not found`);
    await setConnectorModes(
      ctx.db,
      input.id,
      { hide: input.hide, delete: input.delete, ban: input.ban },
      input.max_per_hour,
      ctx.actor.id,
      ctx.via,
    );
    return { ok: true };
  },
};
