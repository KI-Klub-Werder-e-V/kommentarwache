import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

export interface DbHandle {
  db: Kysely<DB>;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * One pool per process. `searchPath` lets tests run each file in its own schema on a
 * shared Postgres.
 */
export function createDb(
  connectionString: string,
  opts: { searchPath?: string; max?: number } = {},
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath}` } : {}),
  });
  // numeric and bigint come back as strings by default; the schema keeps ids within
  // the safe integer range, and money columns are read as numbers on purpose.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  // bigint[] (pipeline_configs.shadows and friends) would otherwise come back as strings
  const setParser = pg.types.setTypeParser as (oid: number, parse: (v: string) => unknown) => void;
  setParser(1016, (v) => (v === '{}' ? [] : v.slice(1, -1).split(',').map(Number)));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}
