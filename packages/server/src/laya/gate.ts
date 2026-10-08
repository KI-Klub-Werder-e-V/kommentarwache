/**
 * The go/no-go gate for a candidate stage-1 provider (a Laya checkpoint): judge every
 * labelled comment of a source with the candidate, route under the active policy, and
 * compare with the labels and with the stored primary decisions. The result is a row in
 * `evaluations` with the metrics and whether the thresholds held.
 */

import type { Kysely } from 'kysely';
import type { Policy, Verdict } from '@kommentarwache/contract';
import { SYSTEM_ACTOR_ID, type DB } from '../db/types.js';
import type { Stage1Member } from '../pipeline/stage1.js';
import { route } from '../policy/policy.js';

export interface GateThresholds {
  /** candidate agreement with labels may be at most this much below the primary's */
  agreementTolerance: number;
  /** share of the candidate's ok verdicts that the labels call ok */
  minAutoApprovePrecision: number;
  /** candidate recall of labelled violations may be at most this much below the primary's */
  violationRecallTolerance: number;
  /** the candidate's unsure share may be at most this multiple of the primary's */
  maxUnsureRatio: number;
  maxP95LatencyMs: number;
}

export const GATE_DEFAULTS: GateThresholds = {
  agreementTolerance: 0.02,
  minAutoApprovePrecision: 0.97,
  violationRecallTolerance: 0.05,
  maxUnsureRatio: 1.25,
  maxP95LatencyMs: 1000,
};

export interface GateMetrics {
  labelled: number;
  candidate: {
    agreement: number;
    autoApprovePrecision: number;
    violationRecall: number;
    unsureShare: number;
    p95LatencyMs: number;
    errors: number;
  };
  primary: { agreement: number; violationRecall: number; unsureShare: number };
  checks: Record<string, boolean>;
}

export interface GateResult {
  evaluationId: number;
  passed: boolean;
  metrics: GateMetrics;
}

export async function runGate(
  db: Kysely<DB>,
  opts: {
    candidate: Stage1Member;
    policy: Policy;
    sourceName: string;
    /** which label source to score against; defaults to any human decision, then "expected", then "codex" */
    labelSource?: string;
    thresholds?: Partial<GateThresholds>;
    log?: (line: string) => void;
  },
): Promise<GateResult> {
  const t = { ...GATE_DEFAULTS, ...opts.thresholds };
  const connector = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', opts.sourceName)
    .executeTakeFirstOrThrow(() => new Error(`no source named ${opts.sourceName}`));

  const comments = await db
    .selectFrom('comments as c')
    .leftJoin('comment_outcomes as o', 'o.comment_id', 'c.id')
    .select([
      'c.id',
      'c.revision',
      'c.text',
      'c.context',
      'c.platform_comment_id',
      'o.s1_verdict',
      'o.human_verdict',
    ])
    .where('c.connector_id', '=', connector.id)
    .orderBy('c.id')
    .execute();
  const labels = await db
    .selectFrom('labels')
    .select(['comment_id', 'source', 'verdict'])
    .where('comment_id', 'in', comments.length ? comments.map((c) => c.id) : [0])
    .execute();
  const labelFor = (id: number, human: Verdict | null): Verdict | undefined => {
    if (opts.labelSource)
      return labels.find((l) => l.comment_id === id && l.source === opts.labelSource)?.verdict;
    return (
      human ??
      labels.find((l) => l.comment_id === id && l.source === 'expected')?.verdict ??
      labels.find((l) => l.comment_id === id && l.source === 'codex')?.verdict
    );
  };

  let n = 0;
  let candAgree = 0;
  let primAgree = 0;
  let candOk = 0;
  let candOkRight = 0;
  let labelledViolations = 0;
  let candViolRecall = 0;
  let primViolRecall = 0;
  let candUnsure = 0;
  let primUnsure = 0;
  let errors = 0;
  const latencies: number[] = [];

  for (const c of comments) {
    const label = labelFor(c.id, c.human_verdict);
    if (!label || !c.s1_verdict) continue;
    const started = performance.now();
    const outcome = await opts.candidate.provider.assess({ text: c.text, context: c.context });
    latencies.push(Math.round(performance.now() - started));
    const assessment = await db
      .insertInto('assessments')
      .values({
        comment_id: c.id,
        revision: c.revision,
        provider_config_id: opts.candidate.provider.configId,
        stage: 's1',
        role: 'shadow',
        status: outcome.status,
        model_version: outcome.modelVersion ?? null,
        battery_id: opts.candidate.batteryId,
        answers: outcome.answers ? JSON.stringify(outcome.answers) : null,
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
    if (!outcome.answers) {
      errors++;
      continue;
    }
    const r = route(opts.candidate.mapper, outcome.answers, opts.policy);
    if (assessment) {
      await db
        .insertInto('decisions')
        .values({
          comment_id: c.id,
          revision: c.revision,
          stage: 's1',
          effective: false,
          verdict: r.verdict,
          category: r.category,
          reasons: JSON.stringify(r.reasons),
          provider_config_id: opts.candidate.provider.configId,
          assessment_ids: [assessment.id],
          actor_id: SYSTEM_ACTOR_ID,
          via: 'cli',
        })
        .execute();
    }
    n++;
    if (r.verdict === label) candAgree++;
    if (c.s1_verdict === label) primAgree++;
    if (r.verdict === 'ok') {
      candOk++;
      if (label === 'ok') candOkRight++;
    }
    if (label === 'violation') {
      labelledViolations++;
      if (r.verdict === 'violation') candViolRecall++;
      if (c.s1_verdict === 'violation') primViolRecall++;
    }
    if (r.verdict === 'unsure') candUnsure++;
    if (c.s1_verdict === 'unsure') primUnsure++;
    opts.log?.(
      `${c.platform_comment_id.padEnd(20)} label=${label.padEnd(9)} primary=${c.s1_verdict.padEnd(9)} candidate=${r.verdict}`,
    );
  }

  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
  const safe = (a: number, b: number) => (b ? a / b : 0);
  const metrics: GateMetrics = {
    labelled: n,
    candidate: {
      agreement: safe(candAgree, n),
      autoApprovePrecision: safe(candOkRight, candOk),
      violationRecall: safe(candViolRecall, labelledViolations),
      unsureShare: safe(candUnsure, n),
      p95LatencyMs: p95,
      errors,
    },
    primary: {
      agreement: safe(primAgree, n),
      violationRecall: safe(primViolRecall, labelledViolations),
      unsureShare: safe(primUnsure, n),
    },
    checks: {},
  };
  metrics.checks = {
    enoughLabels: n >= 50,
    agreement: metrics.candidate.agreement >= metrics.primary.agreement - t.agreementTolerance,
    autoApprovePrecision: metrics.candidate.autoApprovePrecision >= t.minAutoApprovePrecision,
    violationRecall:
      metrics.candidate.violationRecall >=
      metrics.primary.violationRecall - t.violationRecallTolerance,
    unsureShare:
      metrics.candidate.unsureShare <=
      Math.max(metrics.primary.unsureShare, 0.01) * t.maxUnsureRatio,
    latency: metrics.candidate.p95LatencyMs <= t.maxP95LatencyMs,
    noErrors: errors === 0,
  };
  const passed = Object.values(metrics.checks).every(Boolean);

  const row = await db
    .insertInto('evaluations')
    .values({
      provider_config_id: opts.candidate.provider.configId,
      kind: 'laya_gate',
      metrics: JSON.stringify({ source: opts.sourceName, thresholds: t, ...metrics }),
      gate_passed: passed,
      decided_by: SYSTEM_ACTOR_ID,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { evaluationId: row.id, passed, metrics };
}
