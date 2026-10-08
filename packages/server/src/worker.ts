/**
 * Background work on graphile-worker: stage 2 (one at a time, most harmful first),
 * stage 1 for comments that arrive asynchronously, and the deadline reconciler every
 * minute. Jobs are rows in Postgres, enqueued in the same transaction as the state
 * change that needs them.
 */

import { run, runMigrations, type Runner, type TaskList } from 'graphile-worker';
import type { Logger } from 'pino';
import { pollAll } from './connectors/poll.js';
import type { DbHandle } from './db/client.js';
import { WORKER_SCHEMA } from './pipeline/queue.js';
import { reconcileDeadlines } from './pipeline/reconcile.js';
import { ProviderFailed, runStage1 } from './pipeline/stage1.js';
import { runStage2 } from './pipeline/stage2.js';
import type { ActivePipeline } from './providers/registry.js';

export interface WorkerDeps {
  handle: DbHandle;
  pipeline: () => Promise<ActivePipeline>;
  log: Logger;
  schema?: string;
  /** how many stage-1 jobs may run at once; stage 2 is always serial */
  concurrency?: number;
  /** how often sources are polled */
  pollMinutes?: number;
}

export function buildTasks(deps: WorkerDeps): TaskList {
  return {
    stage1: async (payload) => {
      const { commentId } = payload as { commentId: number };
      const pipeline = await deps.pipeline();
      try {
        const r = await runStage1(deps.handle.db, pipeline, commentId);
        deps.log.info({ commentId, verdict: r.routing.verdict, cached: r.cached }, 'stage 1');
      } catch (err) {
        if (err instanceof ProviderFailed)
          deps.log.warn({ commentId, err: err.message }, 'stage 1 provider failed');
        throw err;
      }
    },
    stage2: async (payload) => {
      const { commentId } = payload as { commentId: number };
      const pipeline = await deps.pipeline();
      if (!pipeline.judge) {
        deps.log.warn(
          { commentId },
          'no stage-2 judge configured; the deadline will route it to a human',
        );
        return;
      }
      try {
        const r = await runStage2(
          deps.handle.db,
          {
            judge: pipeline.judge,
            policy: pipeline.policy,
            policyId: pipeline.policyId,
            pipelineConfigId: pipeline.pipelineConfigId,
            afterDecision: pipeline.afterDecision,
          },
          commentId,
        );
        deps.log.info(
          {
            commentId,
            s1: r.s1Verdict,
            s2: r.s2Verdict,
            outcome: r.outcome,
            reason: r.reviewReason,
            cached: r.cached,
          },
          'stage 2',
        );
      } catch (err) {
        if (err instanceof ProviderFailed)
          deps.log.warn({ commentId, err: err.message }, 'stage 2 judge failed');
        else if (/not waiting for stage 2/.test((err as Error).message)) return; // deadline passed first
        throw err;
      }
    },
    poll: async () => {
      const pipeline = await deps.pipeline();
      const results = await pollAll(deps.handle.db, {
        connectors: pipeline.connectors,
        secretKey: pipeline.secretKey,
        log: deps.log,
      });
      const fetched = results.reduce((n, r) => n + r.fetched, 0);
      if (fetched || results.some((r) => r.error)) deps.log.info({ results }, 'poll round');
    },
    reconcile: async () => {
      const r = await reconcileDeadlines(deps.handle.db);
      if (r.timedOut) deps.log.info(r, 'stage-2 deadlines passed; sent to humans');
    },
  };
}

export async function startWorker(deps: WorkerDeps): Promise<Runner> {
  const schema = deps.schema ?? WORKER_SCHEMA;
  await runMigrations({ pgPool: deps.handle.pool, schema });
  return run({
    pgPool: deps.handle.pool,
    schema,
    taskList: buildTasks(deps),
    crontab: ['* * * * * reconcile ?max=1', `*/${deps.pollMinutes ?? 2} * * * * poll ?max=1`].join(
      '\n',
    ),
    concurrency: deps.concurrency ?? 2,
    noHandleSignals: true,
    pollInterval: 2000,
  });
}
