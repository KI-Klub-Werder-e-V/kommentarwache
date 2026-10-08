/**
 * Stage 1: ask the decision provider, route the answers under the active policy, and
 * record both. Idempotent per (comment, revision): a retry after a crash finds the
 * stored assessment or decision and does not call the model again.
 */

import type { Kysely } from 'kysely';
import { CategorySchema, type Policy, type Routing, type Verdict } from '@kommentarwache/contract';
import { SYSTEM_ACTOR_ID, type DB } from '../db/types.js';
import { route } from '../policy/policy.js';
import type { DecisionProvider } from '../providers/provider.js';

export interface Stage1Context {
  provider: DecisionProvider;
  batteryId: number;
  mapper: 'v1' | 'v2';
  policy: Policy;
  policyId: number;
  pipelineConfigId?: number | null;
}

export interface Stage1Result {
  commentId: number;
  revision: number;
  routing: Routing;
  assessmentId: number;
  decisionId: number;
  /** true when an earlier run had already produced the decision */
  cached: boolean;
}

export class ProviderFailed extends Error {
  constructor(
    readonly assessmentId: number,
    readonly status: 'error' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderFailed';
  }
}

export async function runStage1(
  db: Kysely<DB>,
  ctx: Stage1Context,
  commentId: number,
): Promise<Stage1Result> {
  const comment = await db
    .selectFrom('comments')
    .select(['id', 'revision', 'text', 'context', 'state'])
    .where('id', '=', commentId)
    .executeTakeFirstOrThrow(() => new Error(`comment ${commentId} not found`));

  const prior = await db
    .selectFrom('decisions')
    .select(['id', 'verdict', 'category', 'reasons', 'assessment_ids'])
    .where('comment_id', '=', comment.id)
    .where('revision', '=', comment.revision)
    .where('stage', '=', 's1')
    .where('effective', '=', true)
    .executeTakeFirst();
  if (prior) {
    return {
      commentId: comment.id,
      revision: comment.revision,
      routing: {
        verdict: prior.verdict,
        category: CategorySchema.safeParse(prior.category).data ?? 'other',
        reasons: prior.reasons,
      },
      assessmentId: prior.assessment_ids[0] ?? 0,
      decisionId: prior.id,
      cached: true,
    };
  }

  // A stored successful assessment from an interrupted run is reused instead of re-asked.
  const stored = await db
    .selectFrom('assessments')
    .select(['id', 'answers'])
    .where('comment_id', '=', comment.id)
    .where('revision', '=', comment.revision)
    .where('provider_config_id', '=', ctx.provider.configId)
    .where('stage', '=', 's1')
    .where('status', '=', 'ok')
    .executeTakeFirst();

  let assessmentId: number;
  let answers = stored?.answers ?? null;
  if (stored && answers) {
    assessmentId = stored.id;
  } else {
    const outcome = await ctx.provider.assess({ text: comment.text, context: comment.context });
    const inserted = await db
      .insertInto('assessments')
      .values({
        comment_id: comment.id,
        revision: comment.revision,
        provider_config_id: ctx.provider.configId,
        stage: 's1',
        role: 'primary',
        status: outcome.status,
        model_version: outcome.modelVersion ?? null,
        battery_id: ctx.batteryId,
        answers: outcome.answers ? JSON.stringify(outcome.answers) : null,
        raw: outcome.raw ? JSON.stringify(outcome.raw) : null,
        latency_ms: outcome.latencyMs,
        input_tokens: outcome.usage?.input_tokens ?? null,
        output_tokens: outcome.usage?.output_tokens ?? null,
        cost_usd: outcome.costUsd ?? null,
        error: outcome.error ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['comment_id', 'revision', 'provider_config_id', 'stage']).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      // Lost a race with a parallel run of the same comment; let that run finish.
      return runStage1(db, ctx, commentId);
    }
    assessmentId = inserted.id;
    if (outcome.status !== 'ok' || !outcome.answers) {
      throw new ProviderFailed(
        assessmentId,
        outcome.status === 'timeout' ? 'timeout' : 'error',
        outcome.error ?? 'no answers',
      );
    }
    answers = outcome.answers;
  }

  const routing = route(ctx.mapper, answers, ctx.policy);
  const decision = await db.transaction().execute(async (trx) => {
    const d = await trx
      .insertInto('decisions')
      .values({
        comment_id: comment.id,
        revision: comment.revision,
        stage: 's1',
        verdict: routing.verdict,
        category: routing.category,
        reasons: JSON.stringify(routing.reasons),
        policy_id: ctx.policyId,
        provider_config_id: ctx.provider.configId,
        assessment_ids: [assessmentId],
        actor_id: SYSTEM_ACTOR_ID,
        via: 'pipeline',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('comments')
      .set(nextState(routing.verdict, routing.category, ctx.pipelineConfigId ?? null))
      .where('id', '=', comment.id)
      .where('revision', '=', comment.revision)
      .execute();
    return d;
  });

  return {
    commentId: comment.id,
    revision: comment.revision,
    routing,
    assessmentId,
    decisionId: decision.id,
    cached: false,
  };
}

/** Until stage 2 exists (milestone 2), everything that is not ok waits in s2_pending. */
function nextState(verdict: Verdict, category: string, pipelineConfigId: number | null) {
  const base = { pipeline_config_id: pipelineConfigId };
  if (verdict === 'ok') {
    return {
      ...base,
      state: 'closed' as const,
      final_verdict: verdict,
      final_category: category,
      final_stage: 's1' as const,
      closed_at: new Date(),
    };
  }
  return { ...base, state: 's2_pending' as const };
}
