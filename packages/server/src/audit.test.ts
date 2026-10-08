import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyAudit } from './audit.js';
import { testDb, type TestDb } from './test/db.js';

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.teardown();
});

describe('audit log', () => {
  it('chains rows and verifies an intact chain', async () => {
    await appendAudit(t.db, { actorId: 1, via: 'cli', event: 'first' });
    // several keys of different lengths: jsonb stores them in another order than given
    await appendAudit(t.db, {
      actorId: null,
      via: 'dashboard',
      event: 'login.failed',
      payload: { email: 'x', name: 'Mo', nested: { zebra: 1, apple: [3, { b: 1, a: 2 }] } },
    });
    await appendAudit(t.db, {
      actorId: 1,
      via: 'api',
      event: 'third',
      subjectType: 'comment',
      subjectId: 42,
    });
    const rows = await t.db.selectFrom('audit_log').selectAll().orderBy('id').execute();
    expect(rows[0]!.prev_hash).toBeNull();
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
    expect(await verifyAudit(t.db)).toEqual({ rows: 3, brokenAt: null });
  });

  it('cannot be edited: the table is insert-only', async () => {
    await expect(
      t.db.updateTable('audit_log').set({ event: 'tampered' }).execute(),
    ).rejects.toThrow(/insert-only/);
  });

  it('stays linear under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendAudit(t.db, { actorId: 1, via: 'cli', event: `c${i}` }),
      ),
    );
    expect((await verifyAudit(t.db)).brokenAt).toBeNull();
  });
});
