/**
 * The Laya migration pieces: shadow and parallel members in stage 1, the training
 * export with human labels mapped onto the questions, the gate, and the config switches.
 */

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Answers } from '@kommentarwache/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATTERY_V2 } from '../batteries/v2.js';
import { ConnectorRegistry } from '../connectors/connector.js';
import { ingestComment } from '../pipeline/ingest.js';
import { runStage1, type Stage1Context, type Stage1Member } from '../pipeline/stage1.js';
import { POLICIES } from '../policy/policy.js';
import type { AssessOutcome, DecisionProvider } from '../providers/provider.js';
import { activatePipeline, activePipelineRow, loadActivePipeline } from '../providers/registry.js';
import { decideComment } from '../review/decide.js';
import { v2Answers } from '../test/answers.js';
import { testDb, type TestDb } from '../test/db.js';
import { assignSplit, datasetReadiness, expectedFromHuman, exportDataset } from './export.js';
import { runGate } from './gate.js';
import { layaPromote, layaRollback, layaShadow } from './pipeline.js';

const POLICY = POLICIES['severity_led']!;
const VIOLATION: Answers = v2Answers({
  attack: { no_attack: 0.02, attacks_person_or_group: 0.98 },
  target: {
    nobody: 0,
    content_or_product: 0,
    other_commenter: 1,
    public_figure: 0,
    group: 0,
    self: 0,
  },
  severity: { benign: 0, rude: 0.1, harassment: 0.85, threat: 0.05 },
});

function fakeProvider(
  configId: number,
  name: string,
  script: (text: string) => Answers,
): DecisionProvider {
  return {
    configId,
    name,
    kind: 'systemone',
    battery: BATTERY_V2,
    assess: async (input): Promise<AssessOutcome> => ({
      status: 'ok',
      latencyMs: 2,
      modelVersion: name,
      answers: script(input.text),
    }),
  };
}

let t: TestDb;
let connectorId: number;
let batteryId: number;
let policyId: number;
let jevId: number;
let layaId: number;
let primary: Stage1Member;
let laya: Stage1Member;

beforeAll(async () => {
  t = await testDb();
  connectorId = (
    await t.db
      .insertInto('connectors')
      .values({ kind: 'fake', name: 'eval-gold' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  batteryId = (
    await t.db
      .insertInto('batteries')
      .values({
        name: 'v2-choice',
        version: 2,
        questions: JSON.stringify(BATTERY_V2.questions),
        mapper: 'v2',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  policyId = (
    await t.db
      .insertInto('policies')
      .values({ name: 'severity_led', version: 1, spec: JSON.stringify(POLICY) })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  jevId = (
    await t.db
      .insertInto('provider_configs')
      .values({
        name: 'jev-v2@2',
        kind: 'systemone',
        base_url: 'https://api.typesafe.ai',
        model: 'jev-latest',
        battery_id: batteryId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  layaId = (
    await t.db
      .insertInto('provider_configs')
      .values({
        name: 'laya-multilingual@v2.2',
        kind: 'systemone',
        base_url: 'http://laya:8000',
        model: 'multilingual',
        battery_id: batteryId,
        is_local: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  // the "teacher" flags insults; the candidate misses one word to create a disagreement
  primary = {
    provider: fakeProvider(jevId, 'jev', (text) =>
      text.includes('idiot') ? VIOLATION : v2Answers(),
    ),
    batteryId,
    mapper: 'v2',
  };
  laya = {
    provider: fakeProvider(layaId, 'laya', (text) =>
      text.includes('idiot') && !text.includes('mild') ? VIOLATION : v2Answers(),
    ),
    batteryId,
    mapper: 'v2',
  };
});
afterAll(async () => {
  await t.teardown();
});

const ctx = (extra: Partial<Stage1Context> = {}): Stage1Context => ({
  provider: primary.provider,
  batteryId,
  mapper: 'v2',
  policy: POLICY,
  policyId,
  ...extra,
});

describe('shadow and parallel members', () => {
  it('records a shadow decision as non-effective and queues a violation disagreement', async () => {
    const agree = (
      await ingestComment(t.db, { connectorId, platformCommentId: 's1', text: 'you idiot' })
    ).commentId;
    const disagree = (
      await ingestComment(t.db, { connectorId, platformCommentId: 's2', text: 'you mild idiot' })
    ).commentId;
    await runStage1(t.db, ctx({ shadows: [laya] }), agree);
    await runStage1(t.db, ctx({ shadows: [laya] }), disagree);

    const decisions = await t.db
      .selectFrom('decisions')
      .select(['comment_id', 'effective', 'verdict', 'provider_config_id'])
      .where('comment_id', 'in', [agree, disagree])
      .orderBy('id')
      .execute();
    expect(decisions.filter((d) => !d.effective).map((d) => [d.comment_id, d.verdict])).toEqual([
      [agree, 'violation'],
      [disagree, 'ok'],
    ]);
    const effective = decisions.filter((d) => d.effective);
    expect(
      effective.every((d) => d.provider_config_id === jevId && d.verdict === 'violation'),
    ).toBe(true);
    const items = await t.db
      .selectFrom('review_items')
      .select(['comment_id', 'reason'])
      .where('comment_id', 'in', [agree, disagree])
      .execute();
    expect(items).toEqual([{ comment_id: disagree, reason: 'shadow_diff' }]);
  });

  it('turns a parallel disagreement into unsure under all_agree_else_unsure', async () => {
    const id = (
      await ingestComment(t.db, {
        connectorId,
        platformCommentId: 'p1',
        text: 'a mild idiot remark',
      })
    ).commentId;
    const r = await runStage1(
      t.db,
      ctx({ parallel: [laya], combiner: 'all_agree_else_unsure' }),
      id,
    );
    expect(r.routing.verdict).toBe('unsure');
    expect(r.routing.reasons.at(-1)).toMatch(/laya said ok/);
    const assessments = await t.db
      .selectFrom('assessments')
      .select('role')
      .where('comment_id', '=', id)
      .execute();
    expect(assessments.map((a) => a.role).sort()).toEqual(['parallel', 'primary']);
  });
});

describe('export', () => {
  it('maps human verdicts onto the questions and keeps the teacher elsewhere', () => {
    const ok = expectedFromHuman('ok', 'none', VIOLATION);
    expect(ok['attack']).toEqual({
      choice: 'no_attack',
      probabilities: { no_attack: 1, attacks_person_or_group: 0 },
    });
    expect(ok['severity']?.choice).toBe('benign');
    const hate = expectedFromHuman('violation', 'hate', VIOLATION);
    expect(hate['severity']?.choice).toBe('harassment');
    expect(hate['target']?.choice).toBe('group');
    const spam = expectedFromHuman('violation', 'spam', VIOLATION);
    expect(spam['spam']?.choice).toBe('spam_or_scam');
    expect(spam['attack']).toEqual({
      choice: VIOLATION['attack']!.type === 'choice' ? VIOLATION['attack'].choice : '',
      probabilities: (VIOLATION['attack'] as { probabilities: Record<string, number> })
        .probabilities,
    });
  });

  it('splits deterministically and holds the test split for human-labelled comments only', () => {
    expect(assignSplit('thread-1', true, 0.2, 0.1)).toBe(assignSplit('thread-1', true, 0.2, 0.1));
    const splits = Array.from({ length: 300 }, (_, i) => assignSplit(`k${i}`, false, 0.2, 0.1));
    expect(splits).not.toContain('test');
    expect(splits.filter((s) => s === 'calib').length).toBeGreaterThan(10);
  });

  it('writes Laya training lines and records the export', async () => {
    const human = (
      await ingestComment(t.db, { connectorId, platformCommentId: 'e1', text: 'you idiot, truly' })
    ).commentId;
    await runStage1(t.db, ctx(), human);
    await decideComment(t.db, {
      commentId: human,
      verdict: 'ok',
      category: 'none',
      actorId: 1,
      via: 'api',
    });
    const out = join(tmpdir(), `kw-export-${Date.now()}.jsonl`);
    const summary = await exportDataset(t.db, { out, testShare: 1, calibShare: 0 });
    expect(summary.counts.humanLabelled).toBe(1);
    expect(summary.counts.teacherOnly).toBeGreaterThanOrEqual(3);
    const lines = (await readFile(out, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const row = lines.find((l) => l.meta.id === 'e1');
    expect(row.state.comment).toBe('you idiot, truly');
    expect(Object.keys(row.questions)).toEqual(Object.keys(BATTERY_V2.questions));
    expect(row.expected.attack.choice).toBe('no_attack');
    expect(row.meta).toMatchObject({ split: 'test', source: 'human' });
    const items = await t.db
      .selectFrom('dataset_items')
      .selectAll()
      .where('export_id', '=', summary.exportId)
      .execute();
    expect(items.length).toBe(lines.length);
    const readiness = await datasetReadiness(t.db);
    expect(readiness.humanDecisions.ok).toBe(1);
    expect(readiness.ready).toBe(false);
  });
});

describe('gate', () => {
  it('scores the candidate against labels and the primary, and records the evaluation', async () => {
    for (let i = 0; i < 6; i++) {
      const id = (
        await ingestComment(t.db, {
          connectorId,
          platformCommentId: `g${i}`,
          text: i % 2 ? `an idiot said so ${i}` : `fine comment ${i}`,
        })
      ).commentId;
      await runStage1(t.db, ctx(), id);
      await t.db
        .insertInto('labels')
        .values({ comment_id: id, source: 'expected', verdict: i % 2 ? 'violation' : 'ok' })
        .execute();
    }
    const r = await runGate(t.db, {
      candidate: laya,
      policy: POLICY,
      sourceName: 'eval-gold',
      labelSource: 'expected',
      thresholds: { maxP95LatencyMs: 5000 },
    });
    expect(r.metrics.labelled).toBe(6);
    expect(r.metrics.candidate.agreement).toBe(1);
    expect(r.metrics.candidate.violationRecall).toBe(1);
    expect(r.metrics.checks['enoughLabels']).toBe(false); // 6 < 50
    expect(r.passed).toBe(false);
    const row = await t.db
      .selectFrom('evaluations')
      .selectAll()
      .where('id', '=', r.evaluationId)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('laya_gate');
    expect(row.gate_passed).toBe(false);
  });
});

describe('shadow, promote, rollback', () => {
  const env = { layaUrl: 'http://laya:8000', typesafeApiKey: 'k' };

  it('adds Laya as a shadow, promotes it with Jev as shadow, and rolls back', async () => {
    await activatePipeline(t.db, { s1Primary: jevId, s2Primary: null, policyId });
    await t.db
      .insertInto('connector_action_modes')
      .values({ connector_id: connectorId, action_type: 'delete', mode: 'auto' })
      .execute();

    const shadow = await layaShadow(t.db, env, 'multilingual');
    expect(shadow.created).toBe(true);
    let active = await activePipelineRow(t.db);
    expect(active).toMatchObject({ s1_primary: jevId, shadows: [layaId] });
    const loaded = await loadActivePipeline(t.db, env, new ConnectorRegistry());
    expect(loaded.shadows.map((m) => m.provider.name)).toEqual(['laya-multilingual@v2.2']);

    const promoted = await layaPromote(t.db, env, { model: 'multilingual', keepShadow: true });
    expect(promoted.demotedToPropose).toBe(1);
    active = await activePipelineRow(t.db);
    expect(active).toMatchObject({ s1_primary: layaId, shadows: [jevId] });
    const modes = await t.db
      .selectFrom('connector_action_modes')
      .select('mode')
      .where('connector_id', '=', connectorId)
      .executeTakeFirstOrThrow();
    expect(modes.mode).toBe('propose');

    const back = await layaRollback(t.db);
    active = await activePipelineRow(t.db);
    expect(active?.id).toBe(back.pipelineConfigId);
    expect(active).toMatchObject({ s1_primary: jevId, shadows: [layaId] });
  });
});
