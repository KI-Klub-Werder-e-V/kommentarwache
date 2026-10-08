import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATTERY_V2 } from '../batteries/v2.js';
import { POLICIES } from '../policy/policy.js';
import type { AssessOutcome, DecisionProvider, ModerationInput } from '../providers/provider.js';
import type { ActivePipeline } from '../providers/registry.js';
import { v2Answers } from '../test/answers.js';
import { testDb, type TestDb } from '../test/db.js';
import { createApp } from './app.js';
import { createApiToken } from './auth.js';

class ScriptedProvider implements DecisionProvider {
  readonly kind = 'systemone' as const;
  readonly battery = BATTERY_V2;
  calls = 0;
  constructor(
    readonly configId: number,
    readonly name: string,
  ) {}
  async assess(input: ModerationInput): Promise<AssessOutcome> {
    this.calls++;
    if (input.text.includes('idiot')) {
      return {
        status: 'ok',
        modelVersion: 'fake-1',
        latencyMs: 1,
        answers: v2Answers({
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
        }),
      };
    }
    if (input.text.includes('down'))
      return { status: 'timeout', latencyMs: 15000, error: 'timeout calling fake' };
    return { status: 'ok', modelVersion: 'fake-1', latencyMs: 1, answers: v2Answers() };
  }
}

let t: TestDb;
let app: ReturnType<typeof createApp>;
let token: string;
let provider: ScriptedProvider;

beforeAll(async () => {
  t = await testDb();
  const battery = await t.db
    .insertInto('batteries')
    .values({
      name: 'v2-choice',
      version: 1,
      questions: JSON.stringify(BATTERY_V2.questions),
      mapper: 'v2',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const policy = await t.db
    .insertInto('policies')
    .values({ name: 'severity_led', version: 1, spec: JSON.stringify(POLICIES['severity_led']) })
    .returning('id')
    .executeTakeFirstOrThrow();
  const providerRow = await t.db
    .insertInto('provider_configs')
    .values({ name: 'fake', kind: 'systemone', battery_id: battery.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  provider = new ScriptedProvider(providerRow.id, 'fake');
  const pipelineRow = await t.db
    .insertInto('pipeline_configs')
    .values({
      version: 1,
      s1_primary: providerRow.id,
      policy_id: policy.id,
      activated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const pipeline: ActivePipeline = {
    pipelineConfigId: pipelineRow.id,
    provider,
    batteryId: battery.id,
    mapper: 'v2',
    policy: POLICIES['severity_led']!,
    policyId: policy.id,
  };
  app = createApp({ db: t.db, pipeline: async () => pipeline });
  token = (await createApiToken(t.db, { name: 'test-agent', scopes: ['moderate'] })).token;
});
afterAll(async () => {
  await t.teardown();
});

const post = (body: unknown, auth = `Bearer ${token}`) =>
  app.request('/v1/moderate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  });

describe('POST /v1/moderate', () => {
  it('requires a valid token', async () => {
    expect((await post({ text: 'hi' }, '')).status).toBe(401);
    expect((await post({ text: 'hi' }, 'Bearer kw_wrong')).status).toBe(401);
  });

  it('returns the stage-1 verdict and closes an ok comment', async () => {
    const res = await post({ source: 'site', id: 'c1', text: 'lovely article', author_ref: 'u9' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      created: true,
      verdict: 'ok',
      category: 'none',
      state: 'closed',
      model: 'fake-1',
      policy: 'severity_led',
    });
  });

  it('is idempotent on (source, id)', async () => {
    const calls = provider.calls;
    const res = await post({ source: 'site', id: 'c1', text: 'lovely article' });
    expect(await res.json()).toMatchObject({ created: false, verdict: 'ok' });
    expect(provider.calls).toBe(calls);
  });

  it('routes a violation to stage 2', async () => {
    const res = await post({ source: 'site', id: 'c2', text: 'you absolute idiot' });
    expect(await res.json()).toMatchObject({
      verdict: 'violation',
      category: 'harassment',
      state: 's2_pending',
    });
  });

  it('answers 503 when the provider is down, without losing the comment', async () => {
    const res = await post({ source: 'site', id: 'c3', text: 'is the api down?' });
    expect(res.status).toBe(503);
    const row = await t.db
      .selectFrom('comments')
      .select('state')
      .where('platform_comment_id', '=', 'c3')
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('s1_pending');
  });

  it('rejects an invalid body', async () => {
    expect((await post({ text: '' })).status).toBe(400);
  });

  it('serves the OpenAPI document', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.paths['/v1/moderate'].post).toBeDefined();
  });
});
