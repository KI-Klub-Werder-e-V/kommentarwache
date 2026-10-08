/**
 * Deadlines. A comment that stage 2 has not answered in time goes to a human instead
 * of waiting forever; the hide that stage 1 may have placed stays. Runs every minute
 * from the worker's cron and is safe to run as often as you like.
 */

import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface ReconcileResult {
  timedOut: number;
}

export async function reconcileDeadlines(
  db: Kysely<DB>,
  now = new Date(),
): Promise<ReconcileResult> {
  return db.transaction().execute(async (trx) => {
    const overdue = await trx
      .selectFrom('comments')
      .select(['id', 'revision'])
      .where('state', '=', 's2_pending')
      .where('state_deadline_at', 'is not', null)
      .where('state_deadline_at', '<', now)
      .forUpdate()
      .skipLocked()
      .execute();
    if (overdue.length === 0) return { timedOut: 0 };

    const ids = overdue.map((c) => c.id);
    await trx
      .updateTable('comments')
      .set({ state: 'human_pending', state_deadline_at: null })
      .where('id', 'in', ids)
      .execute();
    await trx
      .insertInto('review_items')
      .values(ids.map((id) => ({ comment_id: id, reason: 's2_timeout' as const, priority: 5 })))
      .onConflict((oc) => oc.doNothing())
      .execute();
    return { timedOut: ids.length };
  });
}
