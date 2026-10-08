/**
 * Import the prototype's stored results (Typesafe repo, ContentModeration/) as closed
 * comments with their raw answers, an s1 decision under a named policy, and labels.
 * This is the parity fixture for the policy port and the first eval set.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import {
  fromLegacyVerdict,
  LegacyVerdictSchema,
  type Answers,
  type Policy,
  type Verdict,
} from '@kommentarwache/contract';
import { z } from 'zod';
import { SYSTEM_ACTOR_ID, type DB } from '../db/types.js';
import { POLICIES, routeV1, toV1Answers } from '../policy/policy.js';
import { ensureBattery, ensurePolicy } from '../providers/registry.js';

const FlatAssessment = z.object({
  sentiment: z.string(),
  sentiment_confidence: z.number(),
  sentiment_probabilities: z.record(z.string(), z.number()),
  hostile: z.number(),
  target: z.string(),
  target_confidence: z.number(),
  target_probabilities: z.record(z.string(), z.number()),
  severity: z.number(),
  severity_confidence: z.number(),
  severity_probabilities: z.record(z.string(), z.number()),
  severity_legend: z.record(z.string(), z.string()),
});

const PrototypeRecord = z.object({
  id: z.string(),
  text: z.string(),
  assessment: FlatAssessment,
  expected: LegacyVerdictSchema.nullish(),
  model: z.string(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  latency_s: z.number().optional(),
});

const PrototypeComment = z.object({
  id: z.string(),
  author_idx: z.number().optional(),
  is_reply: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const CodexLabel = z.object({
  id: z.string(),
  verdict: LegacyVerdictSchema,
  sentiment: z.string().optional(),
  note: z.string().optional(),
});

/** The prototype flattened the answers; put them back into the System One shape. */
export function prototypeAnswers(a: z.infer<typeof FlatAssessment>): Answers {
  return {
    sentiment: {
      type: 'choice',
      choice: a.sentiment,
      confidence: a.sentiment_confidence,
      probabilities: a.sentiment_probabilities,
    },
    hostile: { type: 'noul', noul: a.hostile },
    target: {
      type: 'choice',
      choice: a.target,
      confidence: a.target_confidence,
      probabilities: a.target_probabilities,
    },
    severity: {
      type: 'score',
      score: a.severity,
      confidence: a.severity_confidence,
      probabilities: a.severity_probabilities,
      legend: a.severity_legend,
    },
  };
}

export interface ImportOptions {
  connectorName: string;
  resultsPath: string;
  commentsPath?: string;
  codexLabelsPath?: string;
  policyName?: string;
}

export interface ImportSummary {
  connectorId: number;
  imported: number;
  skipped: number;
  verdicts: Record<Verdict, number>;
}

async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => schema.parse(JSON.parse(l)));
}

export async function importPrototype(db: Kysely<DB>, opts: ImportOptions): Promise<ImportSummary> {
  const policyName = opts.policyName ?? 'severity_led';
  const policy = POLICIES[policyName];
  if (!policy) throw new Error(`unknown policy ${policyName}`);

  const records = await readJsonl(opts.resultsPath, PrototypeRecord);
  const comments = new Map(
    opts.commentsPath
      ? (await readJsonl(opts.commentsPath, PrototypeComment)).map((c) => [c.id, c])
      : [],
  );
  const codex = new Map(
    opts.codexLabelsPath
      ? z
          .array(CodexLabel)
          .parse(JSON.parse(await readFile(opts.codexLabelsPath, 'utf8')))
          .map((l) => [l.id, l])
      : [],
  );

  return db.transaction().execute(async (trx) => {
    const connectorId = await ensureConnector(trx, opts.connectorName);
    const batteryId = (await ensureBattery(trx, 'v1')).id;
    const policyId = await ensurePolicy(trx, policy);
    const providerId = await ensureProvider(trx, batteryId);

    const summary: ImportSummary = {
      connectorId,
      imported: 0,
      skipped: 0,
      verdicts: { ok: 0, unsure: 0, violation: 0 },
    };

    for (const r of records) {
      const existing = await trx
        .selectFrom('comments')
        .select('id')
        .where('connector_id', '=', connectorId)
        .where('platform_comment_id', '=', r.id)
        .executeTakeFirst();
      if (existing) {
        summary.skipped++;
        continue;
      }

      const meta = comments.get(r.id);
      const answers = prototypeAnswers(r.assessment);
      const routing = routeV1(toV1Answers(answers), policy);
      const authorId =
        meta?.author_idx !== undefined
          ? await ensureAuthor(trx, connectorId, String(meta.author_idx))
          : null;

      const comment = await trx
        .insertInto('comments')
        .values({
          connector_id: connectorId,
          platform_comment_id: r.id,
          author_id: authorId,
          text: r.text,
          content_hash: sha256(r.text),
          context: JSON.stringify(meta?.context ?? {}),
          is_backfill: true,
          state: 'closed',
          final_verdict: routing.verdict,
          final_category: routing.category,
          final_stage: 's1',
          closed_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const assessment = await trx
        .insertInto('assessments')
        .values({
          comment_id: comment.id,
          revision: 1,
          provider_config_id: providerId,
          stage: 's1',
          role: 'primary',
          status: 'ok',
          model_version: r.model,
          battery_id: batteryId,
          answers: JSON.stringify(answers),
          latency_ms: r.latency_s !== undefined ? Math.round(r.latency_s * 1000) : null,
          input_tokens: r.usage.input_tokens,
          output_tokens: r.usage.output_tokens,
          cost_usd: r.usage.input_tokens * (42 / 1e9),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('decisions')
        .values({
          comment_id: comment.id,
          revision: 1,
          stage: 's1',
          verdict: routing.verdict,
          category: routing.category,
          reasons: JSON.stringify(routing.reasons),
          policy_id: policyId,
          provider_config_id: providerId,
          assessment_ids: [assessment.id],
          actor_id: SYSTEM_ACTOR_ID,
          via: 'cli',
        })
        .execute();

      if (r.expected) {
        await trx
          .insertInto('labels')
          .values({
            comment_id: comment.id,
            source: 'expected',
            verdict: fromLegacyVerdict(r.expected),
          })
          .execute();
      }
      const label = codex.get(r.id);
      if (label) {
        await trx
          .insertInto('labels')
          .values({
            comment_id: comment.id,
            source: 'codex',
            verdict: fromLegacyVerdict(label.verdict),
            sentiment: label.sentiment ?? null,
            note: label.note || null,
          })
          .execute();
      }

      summary.imported++;
      summary.verdicts[routing.verdict]++;
    }
    return summary;
  });
}

export interface ConnectorReport {
  connector: string;
  comments: number;
  s1: Record<Verdict, number>;
  agreement: Array<{ source: string; agree: number; total: number }>;
}

/** Verdict counts and agreement with every label source, the prototype's parity numbers. */
export async function reportConnector(
  db: Kysely<DB>,
  connectorName: string,
): Promise<ConnectorReport> {
  const connector = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', connectorName)
    .executeTakeFirstOrThrow(() => new Error(`no connector named ${connectorName}`));

  const outcomes = await db
    .selectFrom('comment_outcomes')
    .select(['comment_id', 's1_verdict'])
    .where('connector_id', '=', connector.id)
    .execute();
  const s1: Record<Verdict, number> = { ok: 0, unsure: 0, violation: 0 };
  const byComment = new Map<number, Verdict | null>();
  for (const o of outcomes) {
    if (o.s1_verdict) s1[o.s1_verdict]++;
    byComment.set(o.comment_id, o.s1_verdict);
  }

  const labels = await db
    .selectFrom('labels')
    .innerJoin('comments', 'comments.id', 'labels.comment_id')
    .select(['labels.comment_id', 'labels.source', 'labels.verdict'])
    .where('comments.connector_id', '=', connector.id)
    .execute();
  const agreement = new Map<string, { agree: number; total: number }>();
  for (const l of labels) {
    const entry = agreement.get(l.source) ?? { agree: 0, total: 0 };
    entry.total++;
    if (byComment.get(l.comment_id) === l.verdict) entry.agree++;
    agreement.set(l.source, entry);
  }

  return {
    connector: connectorName,
    comments: outcomes.length,
    s1,
    agreement: [...agreement].map(([source, a]) => ({ source, ...a })),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function ensureConnector(db: Kysely<DB>, name: string): Promise<number> {
  const found = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', name)
    .executeTakeFirst();
  if (found) return found.id;
  const row = await db
    .insertInto('connectors')
    .values({ kind: 'import', name, capabilities: [] })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function ensureAuthor(
  db: Kysely<DB>,
  connectorId: number,
  platformAuthorId: string,
): Promise<number> {
  const found = await db
    .selectFrom('authors')
    .select('id')
    .where('connector_id', '=', connectorId)
    .where('platform_author_id', '=', platformAuthorId)
    .executeTakeFirst();
  if (found) return found.id;
  const row = await db
    .insertInto('authors')
    .values({ connector_id: connectorId, platform_author_id: platformAuthorId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function ensureProvider(db: Kysely<DB>, batteryId: number): Promise<number> {
  const name = 'jev-prototype-import';
  const found = await db
    .selectFrom('provider_configs')
    .select('id')
    .where('name', '=', name)
    .executeTakeFirst();
  if (found) return found.id;
  const row = await db
    .insertInto('provider_configs')
    .values({ name, kind: 'import', model: 'jev-1.13.0', battery_id: batteryId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
