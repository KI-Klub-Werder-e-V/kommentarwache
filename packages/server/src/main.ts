/** Service entry point: migrate, load the active pipeline, serve the API. */

import { serve } from '@hono/node-server';
import pino from 'pino';
import { createApp } from './api/app.js';
import { loadDotenv, requireEnv } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { envFromProcess, loadActivePipeline, type ActivePipeline } from './providers/registry.js';

loadDotenv();
const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
const handle = createDb(requireEnv('DATABASE_URL'));

const applied = await migrate(handle.pool);
if (applied.length) log.info({ applied }, 'migrations applied');

// The active pipeline config rarely changes; reload it at most once a minute.
let cached: { at: number; value: Promise<ActivePipeline> } | undefined;
const pipeline = () => {
  if (!cached || Date.now() - cached.at > 60_000) {
    cached = { at: Date.now(), value: loadActivePipeline(handle.db, envFromProcess()) };
    cached.value.catch(() => {
      cached = undefined;
    });
  }
  return cached.value;
};

const app = createApp({ db: handle.db, pipeline });
const port = Number(process.env['PORT'] ?? 8080);
const server = serve(
  { fetch: app.fetch, port, hostname: process.env['HOST'] ?? '0.0.0.0' },
  (info) => {
    log.info({ port: info.port }, 'kommentarwache listening');
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    server.close(() => {
      void handle.close().finally(() => process.exit(0));
    });
  });
}
