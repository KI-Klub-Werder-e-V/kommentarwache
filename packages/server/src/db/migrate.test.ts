import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../test/db.js';

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.teardown();
});

describe('schema', () => {
  it('applies every migration once and records it', async () => {
    const rows = await sql<{
      name: string;
    }>`select name from schema_migrations order by name`.execute(t.db);
    expect(rows.rows.map((r) => r.name)).toEqual(['0001_init.sql']);
  });

  it('seeds the pipeline actor as id 1', async () => {
    const actor = await t.db
      .selectFrom('actors')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(actor.type).toBe('system');
  });

  it('refuses updates and deletes on evidence tables', async () => {
    await t.db
      .insertInto('audit_log')
      .values({ event: 'test', hash: 'h0', payload: JSON.stringify({}) })
      .execute();
    await expect(t.db.updateTable('audit_log').set({ event: 'changed' }).execute()).rejects.toThrow(
      /insert-only/,
    );
    await expect(t.db.deleteFrom('audit_log').execute()).rejects.toThrow(/insert-only/);
  });

  it('exposes the comment_outcomes view', async () => {
    const rows = await t.db.selectFrom('comment_outcomes').selectAll().execute();
    expect(rows).toEqual([]);
  });
});
