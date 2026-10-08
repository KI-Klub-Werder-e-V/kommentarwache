/**
 * Jobs live in Postgres (graphile-worker), so a job is enqueued in the same transaction
 * as the state change that needs it: either both happen or neither.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { EnqueueStage2 } from './stage1.js';

export const WORKER_SCHEMA = process.env['GRAPHILE_WORKER_SCHEMA'] ?? 'graphile_worker';

/** Lower runs first. Clear violations are judged before the merely unsure. */
export function stage2Priority(verdict: string): number {
  return verdict === 'violation' ? -10 : 0;
}

export function makeEnqueueStage2(schema = WORKER_SCHEMA): EnqueueStage2 {
  return async (trx, job) => {
    await sql`
      select ${sql.raw(schema)}.add_job(
        'stage2',
        ${JSON.stringify({ commentId: job.commentId, revision: job.revision })}::json,
        queue_name => 'stage2',
        job_key => ${`stage2:${job.commentId}:${job.revision}`},
        priority => ${stage2Priority(job.verdict)},
        max_attempts => 5
      )
    `.execute(trx);
  };
}

export async function enqueueStage1(
  db: Kysely<DB>,
  commentId: number,
  schema = WORKER_SCHEMA,
): Promise<void> {
  await sql`
    select ${sql.raw(schema)}.add_job(
      'stage1',
      ${JSON.stringify({ commentId })}::json,
      job_key => ${`stage1:${commentId}`},
      max_attempts => 8
    )
  `.execute(db);
}
