/**
 * Export stage-1 evidence as Laya training data. One line per comment in Laya's format,
 * `{state, questions, expected}`, with battery v2's choice questions. Human decisions are
 * gold and override the teacher; otherwise the teacher's probabilities are the target.
 * The export and its split are recorded so a gate can name what it measured.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Kysely } from 'kysely';
import type { Answers, Category, Verdict } from '@kommentarwache/contract';
import { BATTERY_V2 } from '../batteries/v2.js';
import { SYSTEM_ACTOR_ID, type DB } from '../db/types.js';
import { buildState } from '../providers/provider.js';
import { ensureBattery } from '../providers/registry.js';

export type Split = 'train' | 'calib' | 'test';

export interface ExportOptions {
  out: string;
  since?: Date | undefined;
  /** share of human-labelled comments held out as the frozen test split */
  testShare?: number;
  /** share of the rest used for temperature fitting */
  calibShare?: number;
  createdBy?: number;
}

export interface ExportSummary {
  exportId: number;
  file: string;
  sha256: string;
  counts: {
    train: number;
    calib: number;
    test: number;
    humanLabelled: number;
    teacherOnly: number;
  };
}

/**
 * A human verdict mapped onto battery v2's questions. Only what the verdict implies is
 * asserted; questions it says nothing about keep the teacher's distribution.
 */
export function expectedFromHuman(
  verdict: Verdict,
  category: Category | string,
  teacher: Answers,
): Record<string, { choice: string; probabilities: Record<string, number> }> {
  const hard = (choice: string, options: string[]) => ({
    choice,
    probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])),
  });
  const soft = (id: string) => {
    const a = teacher[id];
    return a?.type === 'choice' ? { choice: a.choice, probabilities: a.probabilities } : undefined;
  };
  const attackOpts = ['no_attack', 'attacks_person_or_group'];
  const sevOpts = ['benign', 'rude', 'harassment', 'threat'];
  const spamOpts = ['not_spam', 'spam_or_scam'];
  const out: Record<string, { choice: string; probabilities: Record<string, number> }> = {};
  const sentiment = soft('sentiment');
  if (sentiment) out['sentiment'] = sentiment;
  const target = soft('target');
  if (target) out['target'] = target;

  if (verdict === 'ok') {
    out['attack'] = hard('no_attack', attackOpts);
    out['severity'] = hard('benign', sevOpts);
    out['spam'] = hard('not_spam', spamOpts);
  } else if (category === 'spam' || category === 'scam') {
    out['spam'] = hard('spam_or_scam', spamOpts);
    const attack = soft('attack');
    if (attack) out['attack'] = attack;
    const severity = soft('severity');
    if (severity) out['severity'] = severity;
  } else {
    out['spam'] = hard('not_spam', spamOpts);
    out['attack'] = hard('attacks_person_or_group', attackOpts);
    const level =
      category === 'threat' || category === 'doxxing'
        ? 'threat'
        : category === 'harassment' || category === 'hate'
          ? 'harassment'
          : verdict === 'unsure' || category === 'rude'
            ? 'rude'
            : 'harassment';
    out['severity'] = hard(level, sevOpts);
    if (category === 'hate') {
      out['target'] = hard('group', [
        'nobody',
        'content_or_product',
        'other_commenter',
        'public_figure',
        'group',
        'self',
      ]);
    }
  }
  return out;
}

/** Deterministic split by thread (or comment) so replies stay together. */
export function assignSplit(
  key: string,
  humanLabelled: boolean,
  testShare: number,
  calibShare: number,
): Split {
  const h = parseInt(createHash('sha1').update(key).digest('hex').slice(0, 8), 16) / 0xffffffff;
  if (humanLabelled && h < testShare) return 'test';
  if (h >= 1 - calibShare) return 'calib';
  return 'train';
}

export async function exportDataset(db: Kysely<DB>, opts: ExportOptions): Promise<ExportSummary> {
  const testShare = opts.testShare ?? 0.2;
  const calibShare = opts.calibShare ?? 0.1;
  const battery = await ensureBattery(db, 'v2');

  let q = db
    .selectFrom('assessments as a')
    .innerJoin('comments as c', 'c.id', 'a.comment_id')
    .innerJoin('batteries as b', 'b.id', 'a.battery_id')
    .select([
      'c.id as comment_id',
      'c.text',
      'c.context',
      'c.thread_ref',
      'c.platform_comment_id',
      'a.answers',
    ])
    .where('a.stage', '=', 's1')
    .where('a.role', '=', 'primary')
    .where('a.status', '=', 'ok')
    .where('b.name', '=', BATTERY_V2.name)
    .whereRef('a.revision', '=', 'c.revision')
    .where('c.text_redacted_at', 'is', null)
    .orderBy('c.id');
  if (opts.since) q = q.where('c.ingested_at', '>=', opts.since);
  const rows = await q.execute();

  const humans = await db
    .selectFrom('decisions')
    .select(['comment_id', 'verdict', 'category'])
    .where('stage', '=', 'human')
    .where('effective', '=', true)
    .orderBy('created_at', 'asc')
    .execute();
  const humanBy = new Map<number, { verdict: Verdict; category: string }>();
  for (const h of humans) humanBy.set(h.comment_id, { verdict: h.verdict, category: h.category }); // latest wins

  await mkdir(dirname(opts.out), { recursive: true });
  const stream = createWriteStream(opts.out, { encoding: 'utf8' });
  const hash = createHash('sha256');
  const counts = { train: 0, calib: 0, test: 0, humanLabelled: 0, teacherOnly: 0 };
  const items: Array<{ comment_id: number; split: Split }> = [];

  for (const r of rows) {
    if (!r.answers) continue;
    const human = humanBy.get(r.comment_id);
    const expected = human
      ? expectedFromHuman(human.verdict, human.category, r.answers)
      : Object.fromEntries(
          Object.entries(r.answers)
            .filter(([, a]) => a.type === 'choice')
            .map(([id, a]) => [
              id,
              {
                choice: (a as { choice: string }).choice,
                probabilities: (a as { probabilities: Record<string, number> }).probabilities,
              },
            ]),
        );
    const split = assignSplit(
      r.thread_ref ?? String(r.comment_id),
      Boolean(human),
      testShare,
      calibShare,
    );
    const line = JSON.stringify({
      state: buildState({ text: r.text, context: r.context }),
      questions: battery.battery.questions,
      expected,
      meta: { split, source: human ? 'human' : 'teacher', id: r.platform_comment_id },
    });
    stream.write(line + '\n');
    hash.update(line + '\n');
    counts[split]++;
    if (human) counts.humanLabelled++;
    else counts.teacherOnly++;
    items.push({ comment_id: r.comment_id, split });
  }
  await new Promise<void>((resolve, reject) =>
    stream.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  const sha256 = hash.digest('hex');

  const exportRow = await db
    .insertInto('dataset_exports')
    .values({
      battery_id: battery.id,
      filter: JSON.stringify({ since: opts.since?.toISOString() ?? null, testShare, calibShare }),
      sha256,
      counts: JSON.stringify(counts),
      created_by: opts.createdBy ?? SYSTEM_ACTOR_ID,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (items.length) {
    await db
      .insertInto('dataset_items')
      .values(
        items.map((i) => ({ export_id: exportRow.id, comment_id: i.comment_id, split: i.split })),
      )
      .execute();
  }
  return { exportId: exportRow.id, file: opts.out, sha256, counts };
}

export interface Readiness {
  assessedV2: number;
  humanDecisions: Record<Verdict, number>;
  humanConfirmedViolations: number;
  targets: { cases: number; humanViolations: number };
  ready: boolean;
}

/** How far the collected labels are from the training targets. */
export async function datasetReadiness(db: Kysely<DB>): Promise<Readiness> {
  const assessed = await db
    .selectFrom('assessments as a')
    .innerJoin('batteries as b', 'b.id', 'a.battery_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('a.stage', '=', 's1')
    .where('a.role', '=', 'primary')
    .where('a.status', '=', 'ok')
    .where('b.name', '=', BATTERY_V2.name)
    .executeTakeFirstOrThrow();
  const human = await db
    .selectFrom('decisions')
    .select(['verdict', (eb) => eb.fn.countAll<number>().as('n')])
    .where('stage', '=', 'human')
    .where('effective', '=', true)
    .groupBy('verdict')
    .execute();
  const humanDecisions: Record<Verdict, number> = { ok: 0, unsure: 0, violation: 0 };
  for (const h of human) humanDecisions[h.verdict] = Number(h.n);
  const targets = { cases: 1200, humanViolations: 150 };
  return {
    assessedV2: Number(assessed.n),
    humanDecisions,
    humanConfirmedViolations: humanDecisions.violation,
    targets,
    ready:
      Number(assessed.n) >= targets.cases && humanDecisions.violation >= targets.humanViolations,
  };
}
