import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../test/db.js';
import { importPrototype, reportConnector } from './prototype.js';

// Jev's raw answers for the 24 synthetic comments, as recorded by the prototype.
const SYNTHETIC = fileURLToPath(
  new URL('../../../../eval/sets/synthetic-24.results.jsonl', import.meta.url),
);

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.teardown();
});

describe('importPrototype', () => {
  it('reproduces the prototype: 14 ok, 5 unsure, 5 violations, 23 of 24 as expected', async () => {
    const summary = await importPrototype(t.db, {
      connectorName: 'synthetic',
      resultsPath: SYNTHETIC,
    });
    expect(summary.imported).toBe(24);
    expect(summary.verdicts).toEqual({ ok: 14, unsure: 5, violation: 5 });

    const report = await reportConnector(t.db, 'synthetic');
    expect(report.comments).toBe(24);
    expect(report.agreement).toEqual([{ source: 'expected', agree: 23, total: 24 }]);
  });

  it('stores the raw answers so a policy can be replayed later', async () => {
    const row = await t.db
      .selectFrom('assessments')
      .innerJoin('comments', 'comments.id', 'assessments.comment_id')
      .select(['assessments.answers', 'assessments.model_version', 'assessments.input_tokens'])
      .where('comments.platform_comment_id', '=', 'threat')
      .executeTakeFirstOrThrow();
    expect(row.model_version).toBe('jev-1.13.0');
    expect(row.input_tokens).toBeGreaterThan(0);
    expect(row.answers?.['severity']).toMatchObject({ type: 'score' });
  });

  it('is idempotent: a second import skips every record', async () => {
    const again = await importPrototype(t.db, {
      connectorName: 'synthetic',
      resultsPath: SYNTHETIC,
    });
    expect(again).toMatchObject({ imported: 0, skipped: 24 });
    const count = await t.db
      .selectFrom('comments')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(24);
  });

  it('the strict policy flags more, as in the prototype', async () => {
    const summary = await importPrototype(t.db, {
      connectorName: 'synthetic-strict',
      resultsPath: SYNTHETIC,
      policyName: 'strict',
    });
    expect(summary.verdicts).toEqual({ ok: 14, unsure: 0, violation: 10 });
    const report = await reportConnector(t.db, 'synthetic-strict');
    expect(report.agreement).toEqual([{ source: 'expected', agree: 20, total: 24 }]);
  });
});
