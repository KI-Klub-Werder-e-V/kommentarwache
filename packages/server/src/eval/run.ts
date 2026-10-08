/**
 * The eval harness. `evalSet` runs a labelled JSONL set through stage 1 live and stores
 * everything under an eval connector, so the answers can be replayed under other
 * policies without paying again. `replay` does exactly that: no model calls.
 */

import { readFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { fromLegacyVerdict, LegacyVerdictSchema, VerdictSchema, type Policy, type Verdict } from '@kommentarwache/contract';
import { z } from 'zod';
import type { DB } from '../db/types.js';
import { reportConnector, type ConnectorReport } from './report.js';
import { ingestComment } from '../pipeline/ingest.js';
import { ProviderFailed, runStage1 } from '../pipeline/stage1.js';
import { route } from '../policy/policy.js';
import type { DecisionProvider } from '../providers/provider.js';
import { buildProvider, ensureBattery, ensureJevProvider, ensurePolicy, type ProviderEnv } from '../providers/registry.js';

const EvalItem = z.object({
  id: z.string(),
  text: z.string(),
  expected: z.union([LegacyVerdictSchema, VerdictSchema]).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  author_idx: z.number().optional(),
});
export type EvalItem = z.infer<typeof EvalItem>;

export async function readEvalSet(path: string): Promise<EvalItem[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => EvalItem.parse(JSON.parse(l)));
}

export interface EvalOptions {
  connectorName: string;
  items: EvalItem[];
  batteryShortName: string;
  policy: Policy;
  env: ProviderEnv;
  concurrency?: number;
  /** override the provider, e.g. a fake in tests */
  provider?: DecisionProvider;
  log?: (line: string) => void;
}

export interface EvalSummary extends ConnectorReport {
  failed: number;
  inputTokens: number;
  costUsd: number;
  meanLatencyMs: number;
}

export async function evalSet(db: Kysely<DB>, opts: EvalOptions): Promise<EvalSummary> {
  const battery = await ensureBattery(db, opts.batteryShortName);
  const policyId = await ensurePolicy(db, opts.policy);
  const providerRow = await ensureJevProvider(db, opts.batteryShortName);
  const provider = opts.provider ?? buildProvider(providerRow, battery.battery, opts.env);
  const connectorId = await ensureEvalConnector(db, opts.connectorName);
  const ctx = { provider, batteryId: battery.id, mapper: battery.mapper, policy: opts.policy, policyId };

  let failed = 0;
  const queue = [...opts.items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { commentId } = await ingestComment(db, {
        connectorId,
        platformCommentId: item.id,
        text: item.text,
        ...(item.context ? { context: item.context } : {}),
        ...(item.author_idx !== undefined ? { authorRef: String(item.author_idx) } : {}),
      });
      if (item.expected) {
        const verdict: Verdict = VerdictSchema.safeParse(item.expected).success
          ? (item.expected as Verdict)
          : fromLegacyVerdict(LegacyVerdictSchema.parse(item.expected));
        await db
          .insertInto('labels')
          .values({ comment_id: commentId, source: 'expected', verdict })
          .onConflict((oc) => oc.columns(['comment_id', 'source']).doNothing())
          .execute();
      }
      try {
        const r = await runStage1(db, ctx, commentId);
        opts.log?.(`${r.routing.verdict.padEnd(9)} ${item.id.padEnd(24)} ${r.routing.reasons.join('; ')}`);
      } catch (err) {
        failed++;
        if (err instanceof ProviderFailed) opts.log?.(`FAILED    ${item.id.padEnd(24)} ${err.message}`);
        else throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  const report = await reportConnector(db, opts.connectorName);
  const usage = await db
    .selectFrom('assessments')
    .innerJoin('comments', 'comments.id', 'assessments.comment_id')
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>('assessments.input_tokens'), eb.val(0)).as('input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('assessments.cost_usd'), eb.val(0)).as('cost_usd'),
      eb.fn.coalesce(eb.fn.avg<number>('assessments.latency_ms'), eb.val(0)).as('latency_ms'),
    ])
    .where('comments.connector_id', '=', connectorId)
    .where('assessments.status', '=', 'ok')
    .executeTakeFirstOrThrow();
  return {
    ...report,
    failed,
    inputTokens: Number(usage.input_tokens),
    costUsd: Number(usage.cost_usd),
    meanLatencyMs: Math.round(Number(usage.latency_ms)),
  };
}

export interface ReplayResult {
  connector: string;
  policy: string;
  comments: number;
  verdicts: Record<Verdict, number>;
  agreement: Array<{ source: string; agree: number; total: number }>;
  /** label disagreements, for reading */
  misses: Array<{ id: string; source: string; label: Verdict; got: Verdict; reasons: string[] }>;
}

/** Re-route stored answers under another policy. Reads only; nothing is written. */
export async function replay(db: Kysely<DB>, connectorName: string, policy: Policy): Promise<ReplayResult> {
  const connector = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', connectorName)
    .executeTakeFirstOrThrow(() => new Error(`no connector named ${connectorName}`));
  const rows = await db
    .selectFrom('assessments')
    .innerJoin('comments', 'comments.id', 'assessments.comment_id')
    .innerJoin('batteries', 'batteries.id', 'assessments.battery_id')
    .select(['comments.id as comment_id', 'comments.platform_comment_id', 'assessments.answers', 'batteries.mapper'])
    .where('comments.connector_id', '=', connector.id)
    .where('assessments.stage', '=', 's1')
    .where('assessments.role', '=', 'primary')
    .where('assessments.status', '=', 'ok')
    .whereRef('assessments.revision', '=', 'comments.revision')
    .execute();
  const labels = await db
    .selectFrom('labels')
    .innerJoin('comments', 'comments.id', 'labels.comment_id')
    .select(['labels.comment_id', 'labels.source', 'labels.verdict'])
    .where('comments.connector_id', '=', connector.id)
    .execute();

  const verdicts: Record<Verdict, number> = { ok: 0, unsure: 0, violation: 0 };
  const routed = new Map<number, { id: string; verdict: Verdict; reasons: string[] }>();
  for (const r of rows) {
    if (!r.answers) continue;
    const mapper = r.mapper === 'v1' ? 'v1' : 'v2';
    const routing = route(mapper, r.answers, policy);
    verdicts[routing.verdict]++;
    routed.set(r.comment_id, { id: r.platform_comment_id, verdict: routing.verdict, reasons: routing.reasons });
  }
  const agreement = new Map<string, { agree: number; total: number }>();
  const misses: ReplayResult['misses'] = [];
  for (const l of labels) {
    const got = routed.get(l.comment_id);
    if (!got) continue;
    const entry = agreement.get(l.source) ?? { agree: 0, total: 0 };
    entry.total++;
    if (got.verdict === l.verdict) entry.agree++;
    else misses.push({ id: got.id, source: l.source, label: l.verdict, got: got.verdict, reasons: got.reasons });
    agreement.set(l.source, entry);
  }
  return {
    connector: connectorName,
    policy: policy.name,
    comments: routed.size,
    verdicts,
    agreement: [...agreement].map(([source, a]) => ({ source, ...a })),
    misses,
  };
}

const LabelRecord = z.object({
  id: z.string(),
  verdict: z.union([LegacyVerdictSchema, VerdictSchema]),
  category: z.string().optional(),
  sentiment: z.string().optional(),
  note: z.string().optional(),
});

/**
 * Attach labels from a JSON array or JSONL file to the comments of a connector, under a
 * named source (e.g. "codex" for a blind second reviewer). Existing labels of that
 * source are kept.
 */
export async function importLabels(
  db: Kysely<DB>,
  opts: { connectorName: string; path: string; source: string },
): Promise<{ attached: number; unknownIds: string[] }> {
  const connector = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', opts.connectorName)
    .executeTakeFirstOrThrow(() => new Error(`no connector named ${opts.connectorName}`));
  const text = (await readFile(opts.path, 'utf8')).trim();
  const records = text.startsWith('[')
    ? z.array(LabelRecord).parse(JSON.parse(text))
    : text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => LabelRecord.parse(JSON.parse(l)));

  let attached = 0;
  const unknownIds: string[] = [];
  for (const r of records) {
    const comment = await db
      .selectFrom('comments')
      .select('id')
      .where('connector_id', '=', connector.id)
      .where('platform_comment_id', '=', r.id)
      .executeTakeFirst();
    if (!comment) {
      unknownIds.push(r.id);
      continue;
    }
    const verdict: Verdict = VerdictSchema.safeParse(r.verdict).success
      ? (r.verdict as Verdict)
      : fromLegacyVerdict(LegacyVerdictSchema.parse(r.verdict));
    const inserted = await db
      .insertInto('labels')
      .values({
        comment_id: comment.id,
        source: opts.source,
        verdict,
        category: r.category ?? null,
        sentiment: r.sentiment ?? null,
        note: r.note || null,
      })
      .onConflict((oc) => oc.columns(['comment_id', 'source']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) attached++;
  }
  return { attached, unknownIds };
}

async function ensureEvalConnector(db: Kysely<DB>, name: string): Promise<number> {
  const found = await db.selectFrom('connectors').select('id').where('name', '=', name).executeTakeFirst();
  if (found) return found.id;
  const row = await db.insertInto('connectors').values({ kind: 'eval', name }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
