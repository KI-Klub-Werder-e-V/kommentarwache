/**
 * The actions engine: after a decision, plan what the ladder allows, apply the
 * connector's abilities and the installer's modes, respect the hourly caps, record every
 * action, and execute the automatic ones. Every step is a row; nothing happens on a
 * platform without an actions row saying so first.
 */

import type { Kysely } from 'kysely';
import type { Policy, Verdict } from '@kommentarwache/contract';
import { appendAudit } from '../audit.js';
import type {
  ActionTarget,
  Capability,
  Connector,
  ConnectorRegistry,
} from '../connectors/connector.js';
import {
  SYSTEM_ACTOR_ID,
  type ActionType,
  type ConnectorActionMode,
  type DB,
} from '../db/types.js';
import { decryptSecrets } from '../connectors/secrets.js';
import { ladder, type LadderAction, type LadderInput } from './ladder.js';

export interface EngineDeps {
  connectors: ConnectorRegistry;
  /** KW_SECRET_KEY; without it, connectors that need credentials cannot be built */
  secretKey?: Buffer | undefined;
}

function secretsFor(deps: EngineDeps, blob: Buffer | null): Record<string, unknown> {
  return deps.secretKey ? decryptSecrets(blob, deps.secretKey) : {};
}

export interface Trigger {
  trigger: 's1' | 's2' | 'human';
  commentId: number;
  actorId?: number;
  via?: 'pipeline' | 'dashboard' | 'api' | 'mcp';
}

export interface PlannedRow {
  actionId: number;
  type: ActionType;
  mode: 'auto' | 'dry_run' | 'proposed';
  state: string;
  rule: string;
}

const LADDER_TO_MODE_KEY: Record<LadderAction, 'hide' | 'delete' | 'ban'> = {
  hide: 'hide',
  unhide: 'hide',
  delete: 'delete',
  ban: 'ban',
};

/** Plan and (for `auto`) execute the actions a decision calls for. Idempotent per comment and type. */
export async function applyLadder(
  db: Kysely<DB>,
  deps: EngineDeps,
  policy: Policy,
  t: Trigger,
): Promise<PlannedRow[]> {
  const comment = await db
    .selectFrom('comments')
    .innerJoin('connectors', 'connectors.id', 'comments.connector_id')
    .leftJoin('authors', 'authors.id', 'comments.author_id')
    .select([
      'comments.id',
      'comments.revision',
      'comments.platform_comment_id',
      'comments.thread_ref',
      'comments.is_backfill',
      'comments.author_id',
      'authors.platform_author_id',
      'authors.allowlisted',
      'authors.banned_at',
      'connectors.id as connector_id',
      'connectors.kind',
      'connectors.name as connector_name',
      'connectors.config',
      'connectors.secrets_enc',
      'connectors.enabled',
      'connectors.breaker_open_at',
    ])
    .where('comments.id', '=', t.commentId)
    .executeTakeFirstOrThrow(() => new Error(`comment ${t.commentId} not found`));

  const decisions = await db
    .selectFrom('decisions')
    .select(['stage', 'verdict', 'category'])
    .where('comment_id', '=', comment.id)
    .where('revision', '=', comment.revision)
    .where('effective', '=', true)
    .orderBy('created_at', 'asc')
    .execute();
  const byStage = (s: 's1' | 's2' | 'human') => decisions.filter((d) => d.stage === s).at(-1);
  const s1 = byStage('s1');
  if (!s1) return [];
  const s2 = byStage('s2');
  const human = byStage('human');
  const triggering = byStage(t.trigger) ?? s1;

  const hidden = await isHidden(db, comment.id);
  const strikes = comment.author_id
    ? await authorStrikes(db, comment.author_id, comment.id, policy.actions.strikeWindowDays)
    : 0;

  const input: LadderInput = {
    trigger: t.trigger,
    s1Verdict: s1.verdict,
    s2Verdict: s2?.verdict,
    humanVerdict: human?.verdict,
    category: triggering.category,
    isBackfill: comment.is_backfill,
    authorAllowlisted: comment.allowlisted ?? false,
    authorStrikes: strikes,
    hidden,
    banned: comment.banned_at !== null,
  };
  const planned = ladder(input, policy.actions);
  if (planned.length === 0) return [];

  const connector = deps.connectors.get({
    id: comment.connector_id,
    kind: comment.kind,
    name: comment.connector_name,
    config: comment.config,
    secrets: secretsFor(deps, comment.secrets_enc),
  });
  const modes = await db
    .selectFrom('connector_action_modes')
    .selectAll()
    .where('connector_id', '=', comment.connector_id)
    .execute();
  const modeFor = (type: LadderAction) =>
    modes.find((m) => m.action_type === LADDER_TO_MODE_KEY[type]);
  const target: ActionTarget = {
    platformCommentId: comment.platform_comment_id,
    platformAuthorId: comment.platform_author_id ?? null,
    threadRef: comment.thread_ref,
  };
  const actorId = t.actorId ?? SYSTEM_ACTOR_ID;
  const via = t.via ?? 'pipeline';
  const rows: PlannedRow[] = [];

  for (const p of planned) {
    const capability = p.type as Capability;
    const supported = connector?.capabilities.has(capability) ?? false;
    const m = modeFor(p.type);
    // a human's own verdict is explicit, so the mode only has to be on at all
    const mode: ConnectorActionMode =
      t.trigger === 'human' && m && m.mode !== 'off' ? 'auto' : (m?.mode ?? 'off');

    if (!supported || !connector || !comment.enabled) {
      await queueForHuman(db, comment.id, 'unsupported_action', 5);
      await appendAudit(db, {
        actorId,
        via,
        event: 'action.unsupported',
        subjectType: 'comment',
        subjectId: comment.id,
        payload: { type: p.type, rule: p.rule, connector: comment.connector_name },
      });
      continue;
    }
    if (mode === 'off') continue;

    let effectiveMode = mode;
    if (
      mode === 'auto' &&
      m?.max_per_hour &&
      (await autoActionsLastHour(db, comment.connector_id, m.action_type)) >= m.max_per_hour
    ) {
      effectiveMode = 'propose';
      await appendAudit(db, {
        actorId,
        via,
        event: 'action.cap_tripped',
        subjectType: 'connector',
        subjectId: comment.connector_id,
        payload: { type: p.type, maxPerHour: m.max_per_hour },
      });
    }
    if (comment.breaker_open_at && effectiveMode === 'auto') effectiveMode = 'propose';

    const idempotencyKey =
      p.type === 'ban' || p.type === 'unhide'
        ? `${p.type}:${comment.connector_id}:${comment.author_id ?? comment.id}:${p.type === 'unhide' ? comment.revision : 'author'}`
        : `${p.type}:${comment.id}:${comment.revision}`;
    const inserted = await db
      .insertInto('actions')
      .values({
        connector_id: comment.connector_id,
        comment_id: comment.id,
        author_id: comment.author_id,
        action_type: p.type,
        mode:
          effectiveMode === 'dry_run'
            ? 'dry_run'
            : effectiveMode === 'propose'
              ? 'proposed'
              : 'auto',
        rule: p.rule,
        actor_id: actorId,
        via,
        state: effectiveMode === 'dry_run' ? 'simulated' : 'planned',
        reversible: p.type === 'hide' || p.type === 'ban' || p.type === 'unhide',
        idempotency_key: idempotencyKey,
        executed_at: effectiveMode === 'dry_run' ? new Date() : null,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returning(['id', 'mode', 'state'])
      .executeTakeFirst();
    if (!inserted) continue; // already planned or done for this comment

    if (effectiveMode === 'propose') await queueForHuman(db, comment.id, 'proposed_action', 3);
    if (effectiveMode === 'auto') await executeAction(db, deps, inserted.id);

    const final = await db
      .selectFrom('actions')
      .select(['mode', 'state'])
      .where('id', '=', inserted.id)
      .executeTakeFirstOrThrow();
    rows.push({
      actionId: inserted.id,
      type: p.type,
      mode: final.mode as PlannedRow['mode'],
      state: final.state,
      rule: p.rule,
    });
  }
  return rows;
}

/** Carry out one planned action on its platform and record the outcome. Safe to call twice. */
export async function executeAction(
  db: Kysely<DB>,
  deps: EngineDeps,
  actionId: number,
): Promise<'succeeded' | 'failed' | 'skipped'> {
  const claimed = await db
    .updateTable('actions')
    .set((eb) => ({ state: 'executing', attempts: eb('attempts', '+', 1) }))
    .where('id', '=', actionId)
    .where('state', '=', 'planned')
    .returning(['id'])
    .executeTakeFirst();
  if (!claimed) return 'skipped';

  const a = await db
    .selectFrom('actions')
    .innerJoin('connectors', 'connectors.id', 'actions.connector_id')
    .leftJoin('comments', 'comments.id', 'actions.comment_id')
    .leftJoin('authors', 'authors.id', 'actions.author_id')
    .select([
      'actions.id',
      'actions.action_type',
      'actions.comment_id',
      'actions.author_id',
      'actions.actor_id',
      'actions.via',
      'comments.platform_comment_id',
      'comments.thread_ref',
      'authors.platform_author_id',
      'connectors.id as connector_id',
      'connectors.kind',
      'connectors.name',
      'connectors.config',
      'connectors.secrets_enc',
    ])
    .where('actions.id', '=', actionId)
    .executeTakeFirstOrThrow();

  const connector = deps.connectors.get({
    id: a.connector_id,
    kind: a.kind,
    name: a.name,
    config: a.config,
    secrets: secretsFor(deps, a.secrets_enc),
  });
  const op = connector?.[a.action_type as keyof Connector] as Connector['hide'] | undefined;
  const target: ActionTarget = {
    platformCommentId: a.platform_comment_id ?? '',
    platformAuthorId: a.platform_author_id ?? null,
    threadRef: a.thread_ref ?? null,
  };

  let result: { ok: boolean; response?: Record<string, unknown>; error?: string };
  try {
    result = op
      ? await op.call(connector, target)
      : { ok: false, error: `${a.kind} cannot ${a.action_type}` };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  await db
    .updateTable('actions')
    .set({
      state: result.ok ? 'succeeded' : 'failed',
      platform_response: result.response ? JSON.stringify(result.response) : null,
      error: result.error ?? null,
      executed_at: new Date(),
    })
    .where('id', '=', actionId)
    .execute();

  if (result.ok && a.author_id) {
    if (a.action_type === 'ban')
      await db
        .updateTable('authors')
        .set({ banned_at: new Date() })
        .where('id', '=', a.author_id)
        .execute();
    if (a.action_type === 'unban')
      await db
        .updateTable('authors')
        .set({ banned_at: null })
        .where('id', '=', a.author_id)
        .execute();
  }
  if (!result.ok && a.comment_id) await queueForHuman(db, a.comment_id, 'action_failed', 8);

  await appendAudit(db, {
    actorId: a.actor_id,
    via: a.via as 'pipeline',
    event: result.ok ? 'action.succeeded' : 'action.failed',
    subjectType: 'action',
    subjectId: actionId,
    payload: { type: a.action_type, commentId: a.comment_id, error: result.error ?? null },
  });
  return result.ok ? 'succeeded' : 'failed';
}

/** A moderator executes a proposed action, or undoes a hide or ban. */
export async function executeProposed(
  db: Kysely<DB>,
  deps: EngineDeps,
  actionId: number,
  actorId: number,
  via: 'dashboard' | 'api' | 'mcp',
) {
  await db
    .updateTable('actions')
    .set({ actor_id: actorId, via, mode: 'manual' })
    .where('id', '=', actionId)
    .where('state', '=', 'planned')
    .execute();
  const outcome = await executeAction(db, deps, actionId);
  await db
    .updateTable('review_items')
    .set({ resolved_at: new Date() })
    .where('reason', '=', 'proposed_action')
    .where('resolved_at', 'is', null)
    .where(
      'comment_id',
      'in',
      db
        .selectFrom('actions')
        .select('comment_id')
        .where('id', '=', actionId)
        .where('comment_id', 'is not', null),
    )
    .execute();
  return outcome;
}

export async function undoAction(
  db: Kysely<DB>,
  deps: EngineDeps,
  actionId: number,
  actorId: number,
  via: 'dashboard' | 'api' | 'mcp',
): Promise<{ undoActionId: number; outcome: 'succeeded' | 'failed' | 'skipped' }> {
  const a = await db
    .selectFrom('actions')
    .selectAll()
    .where('id', '=', actionId)
    .executeTakeFirstOrThrow();
  if (a.state !== 'succeeded' || a.undone_at)
    throw new Error(`action ${actionId} is not an executed, un-undone action`);
  const inverse: Partial<Record<ActionType, ActionType>> = { hide: 'unhide', ban: 'unban' };
  const type = inverse[a.action_type];
  if (!type) throw new Error(`a ${a.action_type} cannot be undone; decide the comment instead`);
  const row = await db
    .insertInto('actions')
    .values({
      connector_id: a.connector_id,
      comment_id: a.comment_id,
      author_id: a.author_id,
      action_type: type,
      mode: 'manual',
      rule: `undo of action ${a.id}`,
      actor_id: actorId,
      via,
      state: 'planned',
      reversible: true,
      idempotency_key: `undo:${a.id}`,
      undoes_action_id: a.id,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!row) throw new Error(`action ${actionId} already undone`);
  const outcome = await executeAction(db, deps, row.id);
  if (outcome === 'succeeded')
    await db.updateTable('actions').set({ undone_at: new Date() }).where('id', '=', a.id).execute();
  return { undoActionId: row.id, outcome };
}

/** A moderator's own hide, delete or ban from the comment page: planned and executed at once. */
export async function manualAction(
  db: Kysely<DB>,
  deps: EngineDeps,
  opts: {
    commentId: number;
    type: 'hide' | 'delete' | 'ban';
    actorId: number;
    via: 'dashboard' | 'api' | 'mcp';
    note?: string;
  },
): Promise<{ actionId: number; outcome: 'succeeded' | 'failed' | 'skipped' }> {
  const comment = await db
    .selectFrom('comments')
    .select(['id', 'revision', 'connector_id', 'author_id'])
    .where('id', '=', opts.commentId)
    .executeTakeFirstOrThrow();
  const row = await db
    .insertInto('actions')
    .values({
      connector_id: comment.connector_id,
      comment_id: comment.id,
      author_id: comment.author_id,
      action_type: opts.type,
      mode: 'manual',
      rule: opts.note ?? 'moderator',
      actor_id: opts.actorId,
      via: opts.via,
      state: 'planned',
      reversible: opts.type !== 'delete',
      idempotency_key:
        opts.type === 'ban'
          ? `ban:${comment.connector_id}:${comment.author_id ?? comment.id}:author`
          : `${opts.type}:${comment.id}:${comment.revision}`,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!row) throw new Error(`a ${opts.type} for this comment already exists`);
  return { actionId: row.id, outcome: await executeAction(db, deps, row.id) };
}

/** When a human says ok after a delete, the delete cannot be undone but is marked overturned. */
export async function overturnDeletes(
  db: Kysely<DB>,
  commentId: number,
  decisionId: number,
): Promise<number> {
  const result = await db
    .updateTable('actions')
    .set({ overturned_at: new Date(), overturned_by_decision_id: decisionId })
    .where('comment_id', '=', commentId)
    .where('action_type', '=', 'delete')
    .where('state', '=', 'succeeded')
    .where('overturned_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

async function isHidden(db: Kysely<DB>, commentId: number): Promise<boolean> {
  const last = await db
    .selectFrom('actions')
    .select('action_type')
    .where('comment_id', '=', commentId)
    .where('action_type', 'in', ['hide', 'unhide'])
    .where('state', '=', 'succeeded')
    .orderBy('executed_at', 'desc')
    .executeTakeFirst();
  return last?.action_type === 'hide';
}

/** Confirmed violations by the author in the window, excluding one comment and anything a human overturned. */
export async function authorStrikes(
  db: Kysely<DB>,
  authorId: number,
  excludeCommentId: number,
  windowDays: number,
): Promise<number> {
  const row = await db
    .selectFrom('comments')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('author_id', '=', authorId)
    .where('id', '<>', excludeCommentId)
    .where('state', '=', 'closed')
    .where('final_verdict', '=', 'violation')
    .where('closed_at', '>=', new Date(Date.now() - windowDays * 86_400_000))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function autoActionsLastHour(
  db: Kysely<DB>,
  connectorId: number,
  actionType: string,
): Promise<number> {
  const row = await db
    .selectFrom('actions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('connector_id', '=', connectorId)
    .where('action_type', '=', actionType as ActionType)
    .where('mode', '=', 'auto')
    .where('state', 'in', ['succeeded', 'executing', 'planned'])
    .where('created_at', '>=', new Date(Date.now() - 3_600_000))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function queueForHuman(
  db: Kysely<DB>,
  commentId: number,
  reason: 'unsupported_action' | 'proposed_action' | 'action_failed',
  priority: number,
) {
  await db
    .insertInto('review_items')
    .values({ comment_id: commentId, reason, priority })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export type { Verdict };
