/**
 * Run stage 2 directly over a connector's pending comments, one after another, without
 * the worker. For evaluation: how much of the unsure band does the judge resolve, and
 * how often does it agree with the labels?
 */

import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { ProviderFailed } from '../pipeline/stage1.js';
import { runStage2, type Stage2Context } from '../pipeline/stage2.js';

export interface Stage2RunOptions {
  connectorName: string;
  ctx: Stage2Context;
  limit?: number;
  log?: (line: string) => void;
}

export interface Stage2RunSummary {
  judged: number;
  closed: number;
  human: number;
  failed: number;
  meanLatencyMs: number;
}

export async function runStage2Over(db: Kysely<DB>, opts: Stage2RunOptions): Promise<Stage2RunSummary> {
  const connector = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', opts.connectorName)
    .executeTakeFirstOrThrow(() => new Error(`no connector named ${opts.connectorName}`));
  let query = db
    .selectFrom('comments')
    .select(['id', 'platform_comment_id'])
    .where('connector_id', '=', connector.id)
    .where('state', '=', 's2_pending')
    .orderBy('id');
  if (opts.limit) query = query.limit(opts.limit);
  const pending = await query.execute();

  const summary: Stage2RunSummary = { judged: 0, closed: 0, human: 0, failed: 0, meanLatencyMs: 0 };
  let latencySum = 0;
  for (const c of pending) {
    const started = performance.now();
    try {
      const r = await runStage2(db, opts.ctx, c.id);
      const ms = Math.round(performance.now() - started);
      latencySum += ms;
      summary.judged++;
      if (r.outcome === 'closed') summary.closed++;
      else summary.human++;
      opts.log?.(
        `${String(ms).padStart(6)} ms  ${c.platform_comment_id.padEnd(16)} s1=${r.s1Verdict.padEnd(9)} s2=${r.s2Verdict.padEnd(9)} ${r.outcome}${r.reviewReason ? ` (${r.reviewReason})` : ''}`,
      );
    } catch (err) {
      summary.failed++;
      if (err instanceof ProviderFailed) opts.log?.(`FAILED     ${c.platform_comment_id.padEnd(16)} ${err.message}`);
      else throw err;
    }
  }
  summary.meanLatencyMs = summary.judged ? Math.round(latencySum / summary.judged) : 0;
  return summary;
}
