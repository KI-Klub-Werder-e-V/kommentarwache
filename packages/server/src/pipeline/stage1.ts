/**
 * Stage 1: ask the decision provider, route the answers under the active policy, and
 * record both. Idempotent per (comment, revision): a retry after a crash finds the
 * stored assessment or decision and does not call the model again.
 */

import type { Kysely } from 'kysely';
import {
  CategorySchema,
  type Answers,
  type CommentContext,
  type Policy,
  type Routing,
  type Verdict,
} from '@kommentarwache/contract';
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
  /** queues the stage-2 job inside the same transaction as the decision */
  enqueueStage2?: EnqueueStage2;
  /** the actions engine, called after a decision is committed */
  afterDecision?: AfterDecision;
  /** providers judged alongside the primary; with `all_agree_else_unsure` a disagreement is unsure */
  parallel?: Stage1Member[] | undefined;
  combiner?: 'primary_only' | 'all_agree_else_unsure' | undefined;
  /** providers judged after the decision, recorded but never acted on (the Laya migration) */
  shadows?: Stage1Member[] | undefined;
}

export interface Stage1Member {
  provider: DecisionProvider;
  batteryId: number;
  mapper: 'v1' | 'v2';
}

export type AfterDecision = (t: {
  trigger: 's1' | 's2' | 'human';
  commentId: number;
  actorId?: number;
  via?: 'pipeline' | 'dashboard' | 'api' | 'mcp';
}) => Promise<void>;

export type EnqueueStage2 = (
  trx: Kysely<DB>,
  job: { commentId: number; revision: number; verdict: Verdict },
) => Promise<void>;

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

  let routing = route(ctx.mapper, answers, ctx.policy);
  const assessmentIds = [assessmentId];
  const sideDecisions: Array<{ providerConfigId: number; routing: Routing; assessmentId: number }> =
    [];
  for (const member of ctx.parallel ?? []) {
    const side = await assessMember(db, member, comment, 'parallel');
    if (!side.answers) continue;
    assessmentIds.push(side.assessmentId);
    const r = route(member.mapper, side.answers, ctx.policy);
    sideDecisions.push({
      providerConfigId: member.provider.configId,
      routing: r,
      assessmentId: side.assessmentId,
    });
    if (ctx.combiner === 'all_agree_else_unsure' && r.verdict !== routing.verdict) {
      routing = {
        verdict: 'unsure',
        category: routing.verdict === 'ok' ? r.category : routing.category,
        reasons: [
          ...routing.reasons,
          `${member.provider.name} said ${r.verdict}: ${r.reasons.join('; ') || 'no reason'}`,
        ],
      };
    }
  }

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
        assessment_ids: assessmentIds,
        actor_id: SYSTEM_ACTOR_ID,
        via: 'pipeline',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const side of sideDecisions) {
      await trx
        .insertInto('decisions')
        .values({
          comment_id: comment.id,
          revision: comment.revision,
          stage: 's1',
          effective: false,
          verdict: side.routing.verdict,
          category: side.routing.category,
          reasons: JSON.stringify(side.routing.reasons),
          policy_id: ctx.policyId,
          provider_config_id: side.providerConfigId,
          assessment_ids: [side.assessmentId],
          actor_id: SYSTEM_ACTOR_ID,
          via: 'pipeline',
        })
        .execute();
    }
    const next = nextState(routing.verdict, routing.category, ctx);
    await trx
      .updateTable('comments')
      .set(next)
      .where('id', '=', comment.id)
      .where('revision', '=', comment.revision)
      .execute();
    if (next.state === 's2_pending' && ctx.enqueueStage2) {
      await ctx.enqueueStage2(trx, {
        commentId: comment.id,
        revision: comment.revision,
        verdict: routing.verdict,
      });
    }
    return d;
  });

  // Shadows are judged after the decision and recorded as non-effective decisions. A
  // disagreement that involves a violation is worth a human look during a migration.
  for (const member of ctx.shadows ?? []) {
    try {
      const side = await assessMember(db, member, comment, 'shadow');
      if (!side.answers) continue;
      const r = route(member.mapper, side.answers, ctx.policy);
      await db
        .insertInto('decisions')
        .values({
          comment_id: comment.id,
          revision: comment.revision,
          stage: 's1',
          effective: false,
          verdict: r.verdict,
          category: r.category,
          reasons: JSON.stringify(r.reasons),
          policy_id: ctx.policyId,
          provider_config_id: member.provider.configId,
          assessment_ids: [side.assessmentId],
          actor_id: SYSTEM_ACTOR_ID,
          via: 'pipeline',
        })
        .execute();
      if (
        r.verdict !== routing.verdict &&
        (r.verdict === 'violation' || routing.verdict === 'violation')
      ) {
        await db
          .insertInto('review_items')
          .values({ comment_id: comment.id, reason: 'shadow_diff', priority: -5 })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    } catch {
      // a shadow must never affect the comment; its failure is in the assessment row
    }
  }

  // Actions follow the decision, never inside its transaction: a platform call that
  // fails must not undo the decision.
  if (routing.verdict !== 'ok' && ctx.afterDecision) {
    await ctx.afterDecision({ trigger: 's1', commentId: comment.id });
  }

  return {
    commentId: comment.id,
    revision: comment.revision,
    routing,
    assessmentId,
    decisionId: decision.id,
    cached: false,
  };
}

/** ok closes the comment; anything else waits for stage 2 with a deadline. */
function nextState(verdict: Verdict, category: string, ctx: Stage1Context) {
  const base = { pipeline_config_id: ctx.pipelineConfigId ?? null };
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
  return {
    ...base,
    state: 's2_pending' as const,
    state_deadline_at: new Date(Date.now() + ctx.policy.stage2.deadlineSeconds * 1000),
  };
}

/** Judge a comment with a parallel or shadow member; idempotent per provider, errors recorded. */
async function assessMember(
  db: Kysely<DB>,
  member: Stage1Member,
  comment: { id: number; revision: number; text: string; context: CommentContext },
  role: 'parallel' | 'shadow',
): Promise<{ assessmentId: number; answers: Answers | null }> {
  const stored = await db
    .selectFrom('assessments')
    .select(['id', 'answers'])
    .where('comment_id', '=', comment.id)
    .where('revision', '=', comment.revision)
    .where('provider_config_id', '=', member.provider.configId)
    .where('stage', '=', 's1')
    .executeTakeFirst();
  if (stored) return { assessmentId: stored.id, answers: stored.answers };
  const outcome = await member.provider.assess({ text: comment.text, context: comment.context });
  const inserted = await db
    .insertInto('assessments')
    .values({
      comment_id: comment.id,
      revision: comment.revision,
      provider_config_id: member.provider.configId,
      stage: 's1',
      role,
      status: outcome.status,
      model_version: outcome.modelVersion ?? null,
      battery_id: member.batteryId,
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
  if (!inserted) return assessMember(db, member, comment, role);
  return { assessmentId: inserted.id, answers: outcome.answers ?? null };
}
