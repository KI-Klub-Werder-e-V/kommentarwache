import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { loadActivePipeline, type ActivePipeline, type ProviderEnv } from './registry.js';

/**
 * The active pipeline config rarely changes; reload it at most once a minute so that
 * `kw setup` takes effect without a restart. A failed load is not cached.
 */
export function cachedPipeline(
  db: Kysely<DB>,
  env: ProviderEnv,
  ttlMs = 60_000,
): () => Promise<ActivePipeline> {
  let cached: { at: number; value: Promise<ActivePipeline> } | undefined;
  return () => {
    if (!cached || Date.now() - cached.at > ttlMs) {
      const value = loadActivePipeline(db, env);
      cached = { at: Date.now(), value };
      value.catch(() => {
        if (cached?.value === value) cached = undefined;
      });
    }
    return cached.value;
  };
}
