import type { Answers } from '@kommentarwache/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATTERY_V2 } from '../batteries/v2.js';
import { POLICIES } from '../policy/policy.js';
import type { AssessOutcome, DecisionProvider, ModerationInput } from '../providers/provider.js';
import { testDb, type TestDb } from '../test/db.js';
import { ingestComment } from './ingest.js';
import { ProviderFailed, runStage1, type Stage1Context } from './stage1.js';

/** A provider scripted by comment text, counting calls so idempotency is observable. */
class FakeProvider implements DecisionProvider {
  readonly kind = 'systemone' as const;
  readonly battery = BATTERY_V2;
  calls = 0;
  constructor(
    readonly configId: number,
    readonly name: string,
    private readonly script: (input: ModerationInput) => AssessOutcome,
  ) {}
  async assess(input: ModerationInput): Promise<AssessOutcome> {
    this.calls++;
    return this.script(input);
  }
}

function choiceAnswers(spec: Record<string, Record<string, number>>): Answers {
  const answers: Answers = {};
  for (const [id, probabilities] of Object.entries(spec)) {
    const [choice, p] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
    const n = Object.keys(probabilities).length;
    answers[id] = { type: 'choice', choice, probabilities, confidence: (p - 1 / n) / (1 - 1 / n) };
  }
  return answers;
}

const OK: Answers = choiceAnswers({
  sentiment: { positive: 0.9, neutral: 0.1, negative: 0 },
  attack: { no_attack: 0.98, attacks_person_or_group: 0.02 },
  target: {
    nobody: 0.95,
    content_or_product: 0.05,
    other_commenter: 0,
    public_figure: 0,
    group: 0,
    self: 0,
  },
  severity: { benign: 0.97, rude: 0.03, harassment: 0, threat: 0 },
  spam: { not_spam: 0.99, spam_or_scam: 0.01 },
});
const INSULT: Answers = choiceAnswers({
  sentiment: { positive: 0, neutral: 0.05, negative: 0.95 },
  attack: { no_attack: 0.03, attacks_person_or_group: 0.97 },
  target: {
    nobody: 0,
    content_or_product: 0,
    other_commenter: 0.9,
    public_figure: 0.05,
    group: 0.05,
    self: 0,
  },
  severity: { benign: 0, rude: 0.1, harassment: 0.85, threat: 0.05 },
  spam: { not_spam: 0.99, spam_or_scam: 0.01 },
});

let t: TestDb;
let connectorId: number;
let providerConfigId: number;
let batteryId: number;
let policyId: number;

beforeAll(async () => {
  t = await testDb();
  connectorId = (
    await t.db
      .insertInto('connectors')
      .values({ kind: 'test', name: 'fake' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  batteryId = (
    await t.db
      .insertInto('batteries')
      .values({
        name: 'v2-choice',
        version: 1,
        questions: JSON.stringify(BATTERY_V2.questions),
        mapper: 'v2',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  policyId = (
    await t.db
      .insertInto('policies')
      .values({ name: 'severity_led', version: 1, spec: JSON.stringify(POLICIES['severity_led']) })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  providerConfigId = (
    await t.db
      .insertInto('provider_configs')
      .values({ name: 'fake', kind: 'systemone', battery_id: batteryId })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(async () => {
  await t.teardown();
});

function ctx(provider: DecisionProvider): Stage1Context {
  return { provider, batteryId, mapper: 'v2', policy: POLICIES['severity_led']!, policyId };
}

describe('ingestComment', () => {
  it('stores a comment once, however often it is delivered', async () => {
    const first = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'c1',
      text: 'nice post',
      authorRef: 'u1',
    });
    const second = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'c1',
      text: 'nice post',
      authorRef: 'u1',
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({
      commentId: first.commentId,
      revision: 1,
      created: false,
      edited: false,
    });
  });

  it('bumps the revision when the text changes', async () => {
    await ingestComment(t.db, { connectorId, platformCommentId: 'c2', text: 'v1 text' });
    const edited = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'c2',
      text: 'v2 text',
    });
    expect(edited).toMatchObject({ revision: 2, created: false, edited: true });
  });
});

describe('runStage1', () => {
  it('closes an ok comment and calls the provider exactly once across retries', async () => {
    const provider = new FakeProvider(providerConfigId, 'fake', () => ({
      status: 'ok',
      answers: OK,
      modelVersion: 'fake-1',
      latencyMs: 1,
      usage: { input_tokens: 10, output_tokens: 0 },
    }));
    const { commentId } = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'ok1',
      text: 'thanks, great video',
    });

    const first = await runStage1(t.db, ctx(provider), commentId);
    const again = await runStage1(t.db, ctx(provider), commentId);

    expect(first.routing.verdict).toBe('ok');
    expect(first.cached).toBe(false);
    expect(again).toMatchObject({ decisionId: first.decisionId, cached: true });
    expect(provider.calls).toBe(1);
    const row = await t.db
      .selectFrom('comments')
      .selectAll()
      .where('id', '=', commentId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: 'closed', final_verdict: 'ok', final_stage: 's1' });
  });

  it('routes an insult to stage 2 with the harassment category', async () => {
    const provider = new FakeProvider(providerConfigId, 'fake', () => ({
      status: 'ok',
      answers: INSULT,
      latencyMs: 1,
    }));
    const { commentId } = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'bad1',
      text: 'you idiot',
    });
    const result = await runStage1(t.db, ctx(provider), commentId);
    expect(result.routing).toMatchObject({ verdict: 'violation', category: 'harassment' });
    const row = await t.db
      .selectFrom('comments')
      .select('state')
      .where('id', '=', commentId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('s2_pending');
  });

  it('records a provider failure as an assessment and throws, so the job can retry later', async () => {
    const provider = new FakeProvider(providerConfigId, 'fake', () => ({
      status: 'timeout',
      latencyMs: 15000,
      error: 'timeout calling x',
    }));
    const { commentId } = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'slow1',
      text: 'hello?',
    });
    await expect(runStage1(t.db, ctx(provider), commentId)).rejects.toThrow(ProviderFailed);
    const a = await t.db
      .selectFrom('assessments')
      .selectAll()
      .where('comment_id', '=', commentId)
      .executeTakeFirstOrThrow();
    expect(a).toMatchObject({ status: 'timeout', answers: null });
    const decisions = await t.db
      .selectFrom('decisions')
      .selectAll()
      .where('comment_id', '=', commentId)
      .execute();
    expect(decisions).toEqual([]);
  });

  it('reuses a stored assessment if the run died before deciding', async () => {
    const provider = new FakeProvider(providerConfigId, 'fake', () => ({
      status: 'ok',
      answers: OK,
      latencyMs: 1,
    }));
    const { commentId } = await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'crash1',
      text: 'fine',
    });
    // simulate: assessment written, process died before the decision
    await t.db
      .insertInto('assessments')
      .values({
        comment_id: commentId,
        revision: 1,
        provider_config_id: providerConfigId,
        stage: 's1',
        role: 'primary',
        status: 'ok',
        battery_id: batteryId,
        answers: JSON.stringify(OK),
      })
      .execute();
    const result = await runStage1(t.db, ctx(provider), commentId);
    expect(provider.calls).toBe(0);
    expect(result.routing.verdict).toBe('ok');
  });
});
