/**
 * Plain SQL migrations, applied in file order inside one transaction each and recorded
 * in schema_migrations. No down migrations: the schema only moves forward.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    // Serialise concurrent migrators (two app instances starting at once).
    await client.query('select pg_advisory_lock(727001)');
    try {
      const done = new Set(
        (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
          (r) => r.name,
        ),
      );
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(new URL(file, `file://${MIGRATIONS_DIR}`), 'utf8');
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into schema_migrations (name) values ($1)', [file]);
          await client.query('commit');
        } catch (err) {
          await client.query('rollback');
          throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
        applied.push(file);
      }
    } finally {
      await client.query('select pg_advisory_unlock(727001)');
    }
  } finally {
    client.release();
  }
  return applied;
}
