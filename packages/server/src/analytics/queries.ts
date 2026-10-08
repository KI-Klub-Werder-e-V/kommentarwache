/**
 * The numbers the dashboard shows. Every one is a query on comment_outcomes, decisions
 * or assessments over a time window; nothing is pre-aggregated.
 */

import { sql, type Kysely } from 'kysely';
import type { Verdict } from '@kommentarwache/contract';
import type { DB } from '../db/types.js';

export interface Window {
  since: Date;
  until?: Date;
}

export interface Overview {
  ingested: number;
  s1: Record<Verdict, number>;
  /** flagged by stage 1: anything that was not ok */
  s1Flagged: number;
  s2Judged: number;
  /** flagged by stage 2: violation verdicts */
  s2Flagged: number;
  /** stage 2 reached a different verdict than stage 1, by direction */
  s2Changed: Record<string, number>;
  final: Record<Verdict, number>;
  humanNeeded: number;
  humanDecided: number;
  humanOverrides: number;
  /** share of ingested comments a human had to read */
  humanShare: number;
  reviewOpen: number;
  reviewByReason: Record<string, number>;
}

export async function overview(db: Kysely<DB>, w: Window): Promise<Overview> {
  const until = w.until ?? new Date();
  const rows = await db
    .selectFrom('comment_outcomes')
    .select([
      'comment_id',
      'state',
      's1_verdict',
      's2_verdict',
      'final_verdict',
      'human_verdict',
      'needed_human',
    ])
    .where('ingested_at', '>=', w.since)
    .where('ingested_at', '<', until)
    .execute();

  const o: Overview = {
    ingested: rows.length,
    s1: { ok: 0, unsure: 0, violation: 0 },
    s1Flagged: 0,
    s2Judged: 0,
    s2Flagged: 0,
    s2Changed: {},
    final: { ok: 0, unsure: 0, violation: 0 },
    humanNeeded: 0,
    humanDecided: 0,
    humanOverrides: 0,
    humanShare: 0,
    reviewOpen: 0,
    reviewByReason: {},
  };
  for (const r of rows) {
    if (r.s1_verdict) {
      o.s1[r.s1_verdict]++;
      if (r.s1_verdict !== 'ok') o.s1Flagged++;
    }
    if (r.s2_verdict) {
      o.s2Judged++;
      if (r.s2_verdict === 'violation') o.s2Flagged++;
      if (r.s1_verdict && r.s2_verdict !== r.s1_verdict) {
        const key = `${r.s1_verdict}->${r.s2_verdict}`;
        o.s2Changed[key] = (o.s2Changed[key] ?? 0) + 1;
      }
    }
    if (r.state === 'closed' && r.final_verdict) o.final[r.final_verdict]++;
    if (r.needed_human) o.humanNeeded++;
    if (r.human_verdict) o.humanDecided++;
  }
  o.humanShare = rows.length ? o.humanNeeded / rows.length : 0;

  const overrides = await db
    .selectFrom('decisions')
    .innerJoin('comments', 'comments.id', 'decisions.comment_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('decisions.stage', '=', 'human')
    .where('decisions.overrides_decision_id', 'is not', null)
    .where('comments.ingested_at', '>=', w.since)
    .where('comments.ingested_at', '<', until)
    .executeTakeFirstOrThrow();
  o.humanOverrides = Number(overrides.n);

  const open = await db
    .selectFrom('review_items')
    .select(['reason', (eb) => eb.fn.countAll<number>().as('n')])
    .where('resolved_at', 'is', null)
    .groupBy('reason')
    .execute();
  for (const r of open) {
    o.reviewByReason[r.reason] = Number(r.n);
    o.reviewOpen += Number(r.n);
  }
  return o;
}

export interface DailyRow {
  day: string;
  ingested: number;
  s1_ok: number;
  s1_unsure: number;
  s1_violation: number;
  human: number;
}

export async function daily(db: Kysely<DB>, w: Window): Promise<DailyRow[]> {
  const until = w.until ?? new Date();
  const rows = await sql<DailyRow>`
    select to_char(date_trunc('day', ingested_at), 'YYYY-MM-DD') as day,
           count(*)::int as ingested,
           count(*) filter (where s1_verdict = 'ok')::int as s1_ok,
           count(*) filter (where s1_verdict = 'unsure')::int as s1_unsure,
           count(*) filter (where s1_verdict = 'violation')::int as s1_violation,
           count(*) filter (where needed_human)::int as human
    from comment_outcomes
    where ingested_at >= ${w.since} and ingested_at < ${until}
    group by 1 order by 1
  `.execute(db);
  return rows.rows;
}

export interface ProviderStats {
  provider: string;
  stage: string;
  calls: number;
  errors: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  costUsd: number;
}

export async function providerStats(db: Kysely<DB>, w: Window): Promise<ProviderStats[]> {
  const until = w.until ?? new Date();
  const rows = await sql<ProviderStats>`
    select p.name as provider, a.stage,
           count(*)::int as calls,
           count(*) filter (where a.status <> 'ok')::int as errors,
           coalesce(avg(a.latency_ms) filter (where a.status = 'ok'), 0)::int as "meanLatencyMs",
           coalesce(percentile_cont(0.95) within group (order by a.latency_ms) filter (where a.status = 'ok'), 0)::int as "p95LatencyMs",
           coalesce(sum(a.input_tokens), 0)::int as "inputTokens",
           coalesce(sum(a.cost_usd), 0)::float as "costUsd"
    from assessments a join provider_configs p on p.id = a.provider_config_id
    where a.created_at >= ${w.since} and a.created_at < ${until}
    group by 1, 2 order by 2, 1
  `.execute(db);
  return rows.rows;
}
