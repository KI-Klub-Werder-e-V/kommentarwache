/**
 * The queue end to end: stage 1 enqueues a stage-2 job inside its transaction, the
 * worker picks it up, the judge answers, the comment closes. Uses its own
 * graphile-worker schema so test files cannot see each other's jobs.
 */

import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATTERY_V2 } from './batteries/v2.js';
import { ingestComment } from './pipeline/ingest.js';
import { makeEnqueueStage2 } from './pipeline/queue.js';
import { runStage1 } from './pipeline/stage1.js';
import { POLICIES } from './policy/policy.js';
import type { JudgeOutcome, JudgeProvider } from './providers/llmjudge.js';
import type { AssessOutcome, DecisionProvider } from './providers/provider.js';
import type { ActivePipeline } from './providers/registry.js';
import { v2Answers } from './test/answers.js';
import { testDb, type TestDb } from './test/db.js';
import { startWorker } from './worker.js';

const POLICY = POLICIES['severity_led']!;
const schema = `gw_${randomBytes(4).toString('hex')}`;

let t: TestDb;
let runner: Awaited<ReturnType<typeof startWorker>>;
let pipeline: ActivePipeline;
let connectorId: number;
let judgeCalls = 0;

beforeAll(async () => {
  t = await testDb();
  connectorId = (
    await t.db
      .insertInto('connectors')
      .values({ kind: 'test', name: 'q' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const battery = await t.db
    .insertInto('batteries')
    .values({
      name: 'v2-choice',
      version: 2,
      questions: JSON.stringify(BATTERY_V2.questions),
      mapper: 'v2',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const policy = await t.db
    .insertInto('policies')
    .values({ name: 'severity_led', version: 1, spec: JSON.stringify(POLICY) })
    .returning('id')
    .executeTakeFirstOrThrow();
  const p1 = await t.db
    .insertInto('provider_configs')
    .values({ name: 's1', kind: 'systemone', battery_id: battery.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const p2 = await t.db
    .insertInto('provider_configs')
    .values({ name: 's2', kind: 'llm_judge' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const provider: DecisionProvider = {
    configId: p1.id,
    name: 's1',
    kind: 'systemone',
    battery: BATTERY_V2,
    assess: async (): Promise<AssessOutcome> => ({
      status: 'ok',
      latencyMs: 1,
      answers: v2Answers({
        attack: { no_attack: 0.2, attacks_person_or_group: 0.8 },
        target: {
          nobody: 0,
          content_or_product: 0,
          other_commenter: 1,
          public_figure: 0,
          group: 0,
          self: 0,
        },
        severity: { benign: 0.1, rude: 0.85, harassment: 0.05, threat: 0 },
      }),
    }),
  };
  const judge: JudgeProvider = {
    configId: p2.id,
    name: 's2',
    judge: async (): Promise<JudgeOutcome> => {
      judgeCalls++;
      const probabilities = { ok: 0.9, unsure: 0.05, violation: 0.05 };
      return {
        status: 'ok',
        verdict: 'ok',
        category: 'none',
        probabilities,
        confidenceSource: 'logprobs',
        rationale: 'banter',
        answers: { verdict: { type: 'choice', choice: 'ok', probabilities, confidence: 0.85 } },
        latencyMs: 1,
      };
    },
  };
  pipeline = {
    pipelineConfigId: null as unknown as number,
    provider,
    batteryId: battery.id,
    mapper: 'v2',
    policy: POLICY,
    policyId: policy.id,
    judge,
    enqueueStage2: makeEnqueueStage2(schema),
  };
  runner = await startWorker({
    handle: t,
    pipeline: async () => pipeline,
    log: pino({ level: 'silent' }),
    schema,
    concurrency: 1,
  });
});

afterAll(async () => {
  await runner?.stop();
  await sql`drop schema if exists ${sql.raw(schema)} cascade`.execute(t.db);
  await t.teardown();
});

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timed out waiting');
}

describe('worker', () => {
  it('runs the stage-2 job that stage 1 enqueued and closes the comment', async () => {
    const { commentId } = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'w1',
      text: 'lol imagine',
    });
    const r1 = await runStage1(t.db, pipeline, commentId);
    expect(r1.routing.verdict).toBe('unsure');

    const row = await waitFor(async () => {
      const c = await t.db
        .selectFrom('comments')
        .selectAll()
        .where('id', '=', commentId)
        .executeTakeFirstOrThrow();
      return c.state === 'closed' ? c : undefined;
    });
    expect(row).toMatchObject({ final_verdict: 'ok', final_stage: 's2' });
    expect(judgeCalls).toBe(1);

    const jobs = await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.raw(schema)}.jobs`.execute(t.db);
    expect(jobs.rows[0]!.n).toBe(0);
  });
});
