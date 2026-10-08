/**
 * Database for tests. Uses TEST_DATABASE_URL when set (fast, local Postgres), otherwise
 * starts a throwaway container. Every caller gets its own schema, migrated from scratch,
 * so test files cannot see each other's rows.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type DbHandle } from '../db/client.js';
import { migrate } from '../db/migrate.js';

let containerUrl: Promise<string> | undefined;

async function baseUrl(): Promise<string> {
  const fromEnv = process.env['TEST_DATABASE_URL'];
  if (fromEnv) return fromEnv;
  containerUrl ??= (async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:17-alpine').start();
    return container.getConnectionUri();
  })();
  return containerUrl;
}

export interface TestDb extends DbHandle {
  schema: string;
  /** drops the schema */
  teardown(): Promise<void>;
}

export async function testDb(): Promise<TestDb> {
  const url = await baseUrl();
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();

  const handle = createDb(url, { searchPath: schema, max: 4 });
  await migrate(handle.pool);
  return {
    ...handle,
    schema,
    teardown: async () => {
      await handle.close();
      const drop = new pg.Client({ connectionString: url });
      await drop.connect();
      await drop.query(`drop schema ${schema} cascade`);
      await drop.end();
    },
  };
}
