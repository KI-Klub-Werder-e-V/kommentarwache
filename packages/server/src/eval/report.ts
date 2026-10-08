/**
 * What happened to a connector's comments: counts per stage, how stage 2 changed
 * stage 1's verdicts, and agreement with every label source for stage 1 and for the
 * final verdict. One query on comment_outcomes plus the labels.
 */

import type { Kysely } from 'kysely';
import type { Verdict } from '@kommentarwache/contract';
import type { DB } from '../db/types.js';

export interface VerdictCounts {
  ok: number;
  unsure: number;
  violation: number;
}

export interface ConnectorReport {
  connector: string;
  comments: number;
  s1: VerdictCounts;
  /** of the comments stage 2 judged */
  s2: VerdictCounts & { judged: number };
  final: VerdictCounts & { closed: number; humanPending: number; stillPending: number };
  /** "s1->s2": count, for the comments stage 2 judged */
  transitions: Record<string, number>;
  agreement: Array<{ source: string; stage: 's1' | 'final'; agree: number; total: number }>;
}

const zero = (): VerdictCounts => ({ ok: 0, unsure: 0, violation: 0 });

export async function reportConnector(db: Kysely<DB>, connectorName: string): Promise<ConnectorReport> {
  const connector = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', connectorName)
    .executeTakeFirstOrThrow(() => new Error(`no connector named ${connectorName}`));

  const outcomes = await db
    .selectFrom('comment_outcomes')
    .select(['comment_id', 'state', 's1_verdict', 's2_verdict', 'final_verdict'])
    .where('connector_id', '=', connector.id)
    .execute();

  const s1 = zero();
  const s2 = { ...zero(), judged: 0 };
  const final = { ...zero(), closed: 0, humanPending: 0, stillPending: 0 };
  const transitions: Record<string, number> = {};
  const s1By = new Map<number, Verdict>();
  const finalBy = new Map<number, Verdict>();
  for (const o of outcomes) {
    if (o.s1_verdict) {
      s1[o.s1_verdict]++;
      s1By.set(o.comment_id, o.s1_verdict);
    }
    if (o.s2_verdict) {
      s2[o.s2_verdict]++;
      s2.judged++;
      const key = `${o.s1_verdict ?? '?'}->${o.s2_verdict}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
    if (o.state === 'closed' && o.final_verdict) {
      final[o.final_verdict]++;
      final.closed++;
      finalBy.set(o.comment_id, o.final_verdict);
    } else if (o.state === 'human_pending') {
      final.humanPending++;
    } else {
      final.stillPending++;
    }
  }

  const labels = await db
    .selectFrom('labels')
    .innerJoin('comments', 'comments.id', 'labels.comment_id')
    .select(['labels.comment_id', 'labels.source', 'labels.verdict'])
    .where('comments.connector_id', '=', connector.id)
    .execute();
  const agreement = new Map<string, { source: string; stage: 's1' | 'final'; agree: number; total: number }>();
  const tally = (stage: 's1' | 'final', source: string, got: Verdict | undefined, label: Verdict) => {
    if (got === undefined) return;
    const key = `${source}:${stage}`;
    const entry = agreement.get(key) ?? { source, stage, agree: 0, total: 0 };
    entry.total++;
    if (got === label) entry.agree++;
    agreement.set(key, entry);
  };
  for (const l of labels) {
    tally('s1', l.source, s1By.get(l.comment_id), l.verdict);
    tally('final', l.source, finalBy.get(l.comment_id), l.verdict);
  }

  return {
    connector: connectorName,
    comments: outcomes.length,
    s1,
    s2,
    final,
    transitions,
    agreement: [...agreement.values()].sort((a, b) => a.source.localeCompare(b.source) || a.stage.localeCompare(b.stage)),
  };
}
