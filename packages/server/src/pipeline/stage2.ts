/**
 * Stage 2: the text LLM gives an independent verdict on a comment stage 1 found unsure
 * (or a clear violation that an irreversible action depends on). Code combines the two
 * stages into a final state: closed, or the human queue. Idempotent per
 * (comment, revision) like stage 1.
 */

import type { Kysely } from 'kysely';
import type { Category, Policy, Verdict } from '@kommentarwache/contract';
import { SYSTEM_ACTOR_ID, type DB, type ReviewReason } from '../db/types.js';
import type { JudgeProvider } from '../providers/llmjudge.js';
import { ProviderFailed } from './stage1.js';

export interface Stage2Context {
  judge: JudgeProvider;
  policy: Policy;
  policyId: number;
  pipelineConfigId?: number | null;
}

export interface Stage2Result {
  commentId: number;
  revision: number;
  s1Verdict: Verdict;
  s2Verdict: Verdict;
  category: Category | string;
  outcome: 'closed' | 'human';
  reviewReason?: ReviewReason;
  decisionId: number;
  cached: boolean;
}

/** How the two stages combine. The table in docs/architecture.md, as code. */
export function combine(
  s1: Verdict,
  s2: Verdict,
): { outcome: 'closed' | 'human'; final?: Verdict; reviewReason?: ReviewReason } {
  if (s1 === 'violation') {
    return s2 === 'violation'
      ? { outcome: 'closed', final: 'violation' }
      : { outcome: 'human', reviewReason: 'stage_disagree' };
  }
  // s1 unsure
  if (s2 === 'ok') return { outcome: 'closed', final: 'ok' };
  if (s2 === 'violation') return { outcome: 'closed', final: 'violation' };
  return { outcome: 'human', reviewReason: 'both_unsure' };
}

/** The judge's verdict counts only above the policy's confidence line. */
export function acceptJudge(
  verdict: Verdict,
  probabilities: Record<Verdict, number>,
  policy: Policy,
): Verdict {
  if (verdict === 'violation' && probabilities.violation >= policy.stage2.violationConfidence)
    return 'violation';
  if (verdict === 'ok' && probabilities.ok >= policy.stage2.okConfidence) return 'ok';
  return 'unsure';
}

export async function runStage2(
  db: Kysely<DB>,
  ctx: Stage2Context,
  commentId: number,
): Promise<Stage2Result> {
  const comment = await db
    .selectFrom('comments')
    .select(['id', 'revision', 'text', 'context', 'state'])
    .where('id', '=', commentId)
    .executeTakeFirstOrThrow(() => new Error(`comment ${commentId} not found`));

  const s1 = await db
    .selectFrom('decisions')
    .select(['verdict', 'category'])
    .where('comment_id', '=', comment.id)
    .where('revision', '=', comment.revision)
    .where('stage', '=', 's1')
    .where('effective', '=', true)
    .executeTakeFirstOrThrow(() => new Error(`comment ${commentId} has no stage-1 decision`));

  const prior = await db
    .selectFrom('decisions')
    .select(['id', 'verdict', 'category'])
    .where('comment_id', '=', comment.id)
    .where('revision', '=', comment.revision)
    .where('stage', '=', 's2')
    .where('effective', '=', true)
    .executeTakeFirst();
  if (prior) {
    const c = combine(s1.verdict, prior.verdict);
    return {
      commentId: comment.id,
      revision: comment.revision,
      s1Verdict: s1.verdict,
      s2Verdict: prior.verdict,
      category: prior.category,
      outcome: c.outcome,
      ...(c.reviewReason ? { reviewReason: c.reviewReason } : {}),
      decisionId: prior.id,
      cached: true,
    };
  }
  if (comment.state !== 's2_pending') {
    throw new Error(`comment ${commentId} is ${comment.state}, not waiting for stage 2`);
  }

  const stored = await db
    .selectFrom('assessments')
    .select(['id', 'answers', 'raw'])
    .where('comment_id', '=', comment.id)
    .where('revision', '=', comment.revision)
    .where('provider_config_id', '=', ctx.judge.configId)
    .where('stage', '=', 's2')
    .where('status', '=', 'ok')
    .executeTakeFirst();

  let assessmentId: number;
  let judged: {
    verdict: Verdict;
    category: Category | string;
    probabilities: Record<Verdict, number>;
    rationale: string;
  };
  if (stored?.answers?.['verdict']?.type === 'choice') {
    const v = stored.answers['verdict'];
    const cat = stored.answers['category'];
    assessmentId = stored.id;
    judged = {
      verdict: v.choice as Verdict,
      category: cat?.type === 'choice' ? cat.choice : 'other',
      probabilities: { ok: 0, unsure: 0, violation: 0, ...v.probabilities } as Record<
        Verdict,
        number
      >,
      rationale: String((stored.raw as { rationale?: unknown } | null)?.rationale ?? ''),
    };
  } else {
    const outcome = await ctx.judge.judge({
      text: comment.text,
      context: comment.context,
      policy: ctx.policy.stage2,
    });
    const inserted = await db
      .insertInto('assessments')
      .values({
        comment_id: comment.id,
        revision: comment.revision,
        provider_config_id: ctx.judge.configId,
        stage: 's2',
        role: 'primary',
        status: outcome.status,
        model_version: outcome.modelVersion ?? null,
        answers: outcome.answers ? JSON.stringify(outcome.answers) : null,
        raw: JSON.stringify({
          rationale: outcome.rationale ?? null,
          confidence_source: outcome.confidenceSource ?? null,
          response: outcome.raw ?? null,
        }),
        latency_ms: outcome.latencyMs,
        input_tokens: outcome.usage?.input_tokens ?? null,
        output_tokens: outcome.usage?.output_tokens ?? null,
        cost_usd: 0,
        error: outcome.error ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['comment_id', 'revision', 'provider_config_id', 'stage']).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return runStage2(db, ctx, commentId);
    assessmentId = inserted.id;
    if (outcome.status !== 'ok' || !outcome.verdict || !outcome.probabilities) {
      throw new ProviderFailed(
        assessmentId,
        outcome.status === 'timeout' ? 'timeout' : 'error',
        outcome.error ?? 'no verdict',
      );
    }
    judged = {
      verdict: outcome.verdict,
      category: outcome.category ?? 'other',
      probabilities: outcome.probabilities,
      rationale: outcome.rationale ?? '',
    };
  }

  const s2Verdict = acceptJudge(judged.verdict, judged.probabilities, ctx.policy);
  const category: Category | string =
    s2Verdict === 'ok' ? 'none' : judged.category !== 'none' ? judged.category : s1.category;
  const reasons = [
    `stage 2 said ${judged.verdict} with P=${judged.probabilities[judged.verdict].toFixed(2)}` +
      (s2Verdict !== judged.verdict ? `, below the ${judged.verdict} line, so unsure` : ''),
    ...(judged.rationale ? [judged.rationale] : []),
  ];
  const c = combine(s1.verdict, s2Verdict);

  const decision = await db.transaction().execute(async (trx) => {
    const d = await trx
      .insertInto('decisions')
      .values({
        comment_id: comment.id,
        revision: comment.revision,
        stage: 's2',
        verdict: s2Verdict,
        category,
        reasons: JSON.stringify(reasons),
        policy_id: ctx.policyId,
        provider_config_id: ctx.judge.configId,
        assessment_ids: [assessmentId],
        actor_id: SYSTEM_ACTOR_ID,
        via: 'pipeline',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    if (c.outcome === 'closed') {
      await trx
        .updateTable('comments')
        .set({
          state: 'closed',
          state_deadline_at: null,
          final_verdict: c.final!,
          final_category: c.final === 'ok' ? 'none' : category,
          final_stage: 's2',
          closed_at: new Date(),
        })
        .where('id', '=', comment.id)
        .where('revision', '=', comment.revision)
        .execute();
    } else {
      await trx
        .updateTable('comments')
        .set({ state: 'human_pending', state_deadline_at: null })
        .where('id', '=', comment.id)
        .where('revision', '=', comment.revision)
        .execute();
      await trx
        .insertInto('review_items')
        .values({
          comment_id: comment.id,
          reason: c.reviewReason!,
          priority: s1.verdict === 'violation' ? 10 : 0,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    return d;
  });

  return {
    commentId: comment.id,
    revision: comment.revision,
    s1Verdict: s1.verdict,
    s2Verdict,
    category,
    outcome: c.outcome,
    ...(c.reviewReason ? { reviewReason: c.reviewReason } : {}),
    decisionId: decision.id,
    cached: false,
  };
}
