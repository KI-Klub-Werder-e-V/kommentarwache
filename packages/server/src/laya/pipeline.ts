/**
 * The Laya migration as pipeline-config changes: add Laya as a shadow, promote it to
 * primary with Jev as the shadow, or roll back to the previous config. Every step is a
 * new immutable config version; nothing is edited in place.
 */

import type { Kysely } from 'kysely';
import { appendAudit } from '../audit.js';
import { SYSTEM_ACTOR_ID, type DB } from '../db/types.js';
import {
  activatePipeline,
  activePipelineRow,
  ensureLayaProvider,
  type ProviderEnv,
} from '../providers/registry.js';

export async function layaShadow(
  db: Kysely<DB>,
  env: ProviderEnv,
  model: string,
  actorId = SYSTEM_ACTOR_ID,
): Promise<{ pipelineConfigId: number; created: boolean; providerName: string }> {
  const active = await activePipelineRow(db);
  if (!active?.s1_primary || !active.policy_id)
    throw new Error('no active pipeline; run `kw setup` first');
  const laya = await ensureLayaProvider(db, env, model);
  const shadows = active.shadows.includes(laya.id) ? active.shadows : [...active.shadows, laya.id];
  const result = await activatePipeline(
    db,
    {
      s1Primary: active.s1_primary,
      s1Parallel: active.s1_parallel,
      s1Combiner: active.s1_combiner,
      s2Primary: active.s2_primary,
      shadows,
      policyId: active.policy_id,
    },
    actorId,
  );
  await appendAudit(db, {
    actorId,
    via: 'cli',
    event: 'laya.shadow',
    subjectType: 'pipeline_config',
    subjectId: result.pipelineConfigId,
    payload: { provider: laya.name },
  });
  return { ...result, providerName: laya.name };
}

/**
 * Laya becomes primary; the previous primary stays as a shadow unless told otherwise.
 * Delete and ban drop from auto to propose on every source for a probation period.
 */
export async function layaPromote(
  db: Kysely<DB>,
  env: ProviderEnv,
  opts: { model: string; keepShadow: boolean },
  actorId = SYSTEM_ACTOR_ID,
): Promise<{ pipelineConfigId: number; created: boolean; demotedToPropose: number }> {
  const active = await activePipelineRow(db);
  if (!active?.s1_primary || !active.policy_id)
    throw new Error('no active pipeline; run `kw setup` first');
  const laya = await ensureLayaProvider(db, env, opts.model);
  const shadows = opts.keepShadow
    ? [
        active.s1_primary,
        ...active.shadows.filter((id) => id !== laya.id && id !== active.s1_primary),
      ]
    : active.shadows.filter((id) => id !== laya.id);
  const result = await activatePipeline(
    db,
    {
      s1Primary: laya.id,
      s1Parallel: active.s1_parallel.filter((id) => id !== laya.id),
      s1Combiner: active.s1_combiner,
      s2Primary: active.s2_primary,
      shadows,
      policyId: active.policy_id,
    },
    actorId,
  );
  const demoted = await db
    .updateTable('connector_action_modes')
    .set({ mode: 'propose' })
    .where('mode', '=', 'auto')
    .where('action_type', 'in', ['delete', 'ban'])
    .executeTakeFirst();
  await appendAudit(db, {
    actorId,
    via: 'cli',
    event: 'laya.promote',
    subjectType: 'pipeline_config',
    subjectId: result.pipelineConfigId,
    payload: {
      provider: laya.name,
      keepShadow: opts.keepShadow,
      demotedToPropose: Number(demoted.numUpdatedRows),
    },
  });
  return { ...result, demotedToPropose: Number(demoted.numUpdatedRows) };
}

/** Reactivate the config that was active before the current one. */
export async function layaRollback(
  db: Kysely<DB>,
  actorId = SYSTEM_ACTOR_ID,
): Promise<{ pipelineConfigId: number; version: number }> {
  const result = await db.transaction().execute(async (trx) => {
    const active = await activePipelineRow(trx);
    const previous = await trx
      .selectFrom('pipeline_configs')
      .selectAll()
      .where('deactivated_at', 'is not', null)
      .orderBy('deactivated_at', 'desc')
      .executeTakeFirst();
    if (!previous) throw new Error('no previous pipeline config to roll back to');
    if (active) {
      await trx
        .updateTable('pipeline_configs')
        .set({ deactivated_at: new Date() })
        .where('id', '=', active.id)
        .execute();
    }
    const latest = await trx
      .selectFrom('pipeline_configs')
      .select((eb) => eb.fn.max('version').as('v'))
      .executeTakeFirst();
    // a rollback is itself a new version, so history stays linear
    const row = await trx
      .insertInto('pipeline_configs')
      .values({
        version: (latest?.v ?? 0) + 1,
        s1_primary: previous.s1_primary,
        s1_parallel: previous.s1_parallel,
        s1_combiner: previous.s1_combiner,
        s2_primary: previous.s2_primary,
        shadows: previous.shadows,
        policy_id: previous.policy_id,
        activated_at: new Date(),
        activated_by: actorId,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    return { pipelineConfigId: row.id, version: row.version, restored: previous.version };
  });
  // the audit log runs its own transaction, so it is written after this one commits
  await appendAudit(db, {
    actorId,
    via: 'cli',
    event: 'laya.rollback',
    subjectType: 'pipeline_config',
    subjectId: result.pipelineConfigId,
    payload: { restored: result.restored },
  });
  return { pipelineConfigId: result.pipelineConfigId, version: result.version };
}
