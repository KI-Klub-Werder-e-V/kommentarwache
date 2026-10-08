/** Service entry point: migrate, start the worker, serve the API. One process is enough. */

import { serve } from '@hono/node-server';
import pino from 'pino';
import { createApp } from './api/app.js';
import { loadDotenv, requireEnv } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { cachedPipeline } from './providers/active.js';
import { envFromProcess } from './providers/registry.js';
import { startWorker } from './worker.js';

loadDotenv();
const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
const handle = createDb(requireEnv('DATABASE_URL'));

const applied = await migrate(handle.pool);
if (applied.length) log.info({ applied }, 'migrations applied');

const pipeline = cachedPipeline(handle.db, envFromProcess());
const runner = process.env['KW_NO_WORKER']
  ? undefined
  : await startWorker({ handle, pipeline, log });

const app = createApp({ db: handle.db, pipeline, log });
const port = Number(process.env['PORT'] ?? 8080);
const server = serve(
  { fetch: app.fetch, port, hostname: process.env['HOST'] ?? '0.0.0.0' },
  (info) => {
    log.info({ port: info.port, worker: Boolean(runner) }, 'kommentarwache listening');
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    server.close(() => {
      void (runner ? runner.stop() : Promise.resolve())
        .then(() => handle.close())
        .finally(() => process.exit(0));
    });
  });
}
