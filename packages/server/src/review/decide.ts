/**
 * A human (or an agent acting for one) decides a comment. The decision is appended,
 * the open review item resolved, the comment closed, and the audit log written, in one
 * transaction. Platform actions that follow are milestone 4.
 */

import type { Kysely } from 'kysely';
import type { Category, Verdict } from '@kommentarwache/contract';
import { appendAudit, type AuditEntry } from '../audit.js';
import type { DB } from '../db/types.js';

export interface HumanDecision {
  commentId: number;
  verdict: Verdict;
  category: Category | string;
  note?: string | undefined;
  actorId: number;
  via: 'dashboard' | 'api' | 'mcp';
}

export interface HumanDecisionResult {
  decisionId: number;
  /** the model decision this one overrides, if the comment had reached a verdict */
  overrides: { stage: 's1' | 's2'; verdict: Verdict } | null;
}

export async function decideComment(
  db: Kysely<DB>,
  d: HumanDecision,
): Promise<HumanDecisionResult> {
  const result = await db.transaction().execute(async (trx) => {
    const comment = await trx
      .selectFrom('comments')
      .select(['id', 'revision', 'state', 'final_verdict', 'final_stage'])
      .where('id', '=', d.commentId)
      .forUpdate()
      .executeTakeFirstOrThrow(() => new Error(`comment ${d.commentId} not found`));

    // The latest model verdict is what this decision overrides: stage 2 if it ran, else stage 1.
    const latestModel = await trx
      .selectFrom('decisions')
      .select(['id', 'stage', 'verdict'])
      .where('comment_id', '=', comment.id)
      .where('revision', '=', comment.revision)
      .where('effective', '=', true)
      .where('stage', 'in', ['s1', 's2'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    const decision = await trx
      .insertInto('decisions')
      .values({
        comment_id: comment.id,
        revision: comment.revision,
        stage: 'human',
        verdict: d.verdict,
        category: d.verdict === 'ok' ? 'none' : d.category,
        reasons: JSON.stringify(d.note ? [d.note] : []),
        actor_id: d.actorId,
        via: d.via,
        overrides_decision_id:
          latestModel && latestModel.verdict !== d.verdict ? latestModel.id : null,
        note: d.note ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('review_items')
      .set({ resolved_at: new Date(), resolution_decision_id: decision.id })
      .where('comment_id', '=', comment.id)
      .where('resolved_at', 'is', null)
      .execute();

    await trx
      .updateTable('comments')
      .set({
        state: 'closed',
        state_deadline_at: null,
        final_verdict: d.verdict,
        final_category: d.verdict === 'ok' ? 'none' : d.category,
        final_stage: 'human',
        closed_at: new Date(),
      })
      .where('id', '=', comment.id)
      .execute();

    return {
      decisionId: decision.id,
      overrides:
        latestModel && latestModel.verdict !== d.verdict
          ? { stage: latestModel.stage as 's1' | 's2', verdict: latestModel.verdict }
          : null,
    };
  });

  const audit: AuditEntry = {
    actorId: d.actorId,
    via: d.via,
    event: 'comment.decided',
    subjectType: 'comment',
    subjectId: d.commentId,
    payload: {
      verdict: d.verdict,
      category: d.category,
      decisionId: result.decisionId,
      overrides: result.overrides,
    },
  };
  await appendAudit(db, audit);
  return result;
}
