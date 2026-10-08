/**
 * The dashboard through HTTP: sign in, see the queue, decide a comment, see the log
 * and the analytics move. The pipeline is faked at the provider level.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overview } from '../analytics/queries.js';
import { createApp } from '../api/app.js';
import { createModerator } from '../auth/moderators.js';
import { BATTERY_V2 } from '../batteries/v2.js';
import { ingestComment } from '../pipeline/ingest.js';
import { runStage1, type Stage1Context } from '../pipeline/stage1.js';
import { runStage2 } from '../pipeline/stage2.js';
import { POLICIES } from '../policy/policy.js';
import type { JudgeOutcome, JudgeProvider } from '../providers/llmjudge.js';
import type { AssessOutcome, DecisionProvider } from '../providers/provider.js';
import type { ActivePipeline } from '../providers/registry.js';
import { v2Answers } from '../test/answers.js';
import { testDb, type TestDb } from '../test/db.js';

const POLICY = POLICIES['severity_led']!;

let t: TestDb;
let app: ReturnType<typeof createApp>;
let cookie = '';
let queuedCommentId: number;
let okCommentId: number;

beforeAll(async () => {
  t = await testDb();
  const connectorId = (
    await t.db
      .insertInto('connectors')
      .values({ kind: 'test', name: 'site' })
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
    .values({ name: 'fake-s1', kind: 'systemone', battery_id: battery.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const p2 = await t.db
    .insertInto('provider_configs')
    .values({ name: 'fake-s2', kind: 'llm_judge' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const unsure = v2Answers({
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
  });
  const provider: DecisionProvider = {
    configId: p1.id,
    name: 'fake-s1',
    kind: 'systemone',
    battery: BATTERY_V2,
    assess: async (input): Promise<AssessOutcome> => ({
      status: 'ok',
      latencyMs: 1,
      modelVersion: 'fake-1',
      answers: input.text.includes('lol') ? unsure : v2Answers(),
    }),
  };
  const judge: JudgeProvider = {
    configId: p2.id,
    name: 'fake-s2',
    judge: async (): Promise<JudgeOutcome> => {
      const probabilities = { ok: 0.3, unsure: 0.5, violation: 0.2 };
      return {
        status: 'ok',
        verdict: 'unsure',
        category: 'rude',
        probabilities,
        confidenceSource: 'logprobs',
        rationale: 'could be banter',
        answers: { verdict: { type: 'choice', choice: 'unsure', probabilities, confidence: 0.25 } },
        latencyMs: 1,
      };
    },
  };
  const s1: Stage1Context = {
    provider,
    batteryId: battery.id,
    mapper: 'v2',
    policy: POLICY,
    policyId: policy.id,
  };
  const pipeline: ActivePipeline = {
    ...s1,
    pipelineConfigId: null as unknown as number,
    judge,
    enqueueStage2: async () => {},
  };
  app = createApp({ db: t.db, pipeline: async () => pipeline });

  await createModerator(t.db, {
    email: 'Mod@Example.org',
    name: 'Mo',
    password: 'correct horse battery',
  });

  okCommentId = (await ingestComment(t.db, { connectorId, platformCommentId: 'a', text: 'lovely' }))
    .commentId;
  await runStage1(t.db, s1, okCommentId);
  queuedCommentId = (
    await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'b',
      text: 'lol imagine',
      permalink: 'https://example.org/c/b',
      authorRef: 'u1',
      authorName: 'Udo',
    })
  ).commentId;
  await runStage1(t.db, s1, queuedCommentId);
  await runStage2(t.db, { judge, policy: POLICY, policyId: policy.id }, queuedCommentId);
});
afterAll(async () => {
  await t.teardown();
});

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const headers = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/x-www-form-urlencoded',
  'sec-fetch-site': 'same-origin',
  ...(cookie ? { cookie } : {}),
  ...extra,
});

describe('dashboard', () => {
  it('redirects an anonymous visitor to the login page', async () => {
    const res = await app.request('/app/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/app\/login\?next=%2Fapp(%2F)?$/);
  });

  it('rejects a wrong password and accepts the right one, case-insensitive on email', async () => {
    const bad = await app.request('/app/login', {
      method: 'POST',
      headers: headers(),
      body: form({ email: 'mod@example.org', password: 'nope nope nope' }),
    });
    expect(bad.status).toBe(401);
    const good = await app.request('/app/login', {
      method: 'POST',
      headers: headers(),
      body: form({ email: 'mod@example.org', password: 'correct horse battery', next: '/app/' }),
    });
    expect(good.status).toBe(302);
    expect(good.headers.get('location')).toBe('/app/');
    cookie = good.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).toMatch(/^kw_session=/);
  });

  it('refuses a cross-site form post', async () => {
    const res = await app.request('/app/login', {
      method: 'POST',
      headers: headers({ 'sec-fetch-site': 'cross-site' }),
      body: form({}),
    });
    expect(res.status).toBe(403);
  });

  it('shows the queued comment with its link and the judge rationale', async () => {
    const res = await app.request('/app/', { headers: headers() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('lol imagine');
    expect(html).toContain('https://example.org/c/b');
    expect(html).toContain('could be banter');
    expect(html).toContain('both unsure');
    expect(html).not.toContain('lovely');
  });

  it('renders the comment detail with its timeline', async () => {
    const res = await app.request(`/app/comments/${queuedCommentId}`, { headers: headers() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('s1 assessment');
    expect(html).toContain('s2 assessment');
    expect(html).toContain('Your decision');
    expect(html).toContain('Udo');
  });

  it('records a human decision, resolves the queue item and shows it in the log', async () => {
    const res = await app.request(`/app/comments/${queuedCommentId}/decide`, {
      method: 'POST',
      headers: headers(),
      body: form({ verdict: 'ok', category: 'none', note: 'banter between regulars' }),
    });
    expect(res.status).toBe(302);
    const comment = await t.db
      .selectFrom('comments')
      .selectAll()
      .where('id', '=', queuedCommentId)
      .executeTakeFirstOrThrow();
    expect(comment).toMatchObject({ state: 'closed', final_verdict: 'ok', final_stage: 'human' });
    const item = await t.db
      .selectFrom('review_items')
      .select('resolved_at')
      .where('comment_id', '=', queuedCommentId)
      .executeTakeFirstOrThrow();
    expect(item.resolved_at).not.toBeNull();
    const decision = await t.db
      .selectFrom('decisions')
      .selectAll()
      .where('comment_id', '=', queuedCommentId)
      .where('stage', '=', 'human')
      .executeTakeFirstOrThrow();
    expect(decision.overrides_decision_id).not.toBeNull();
    expect(decision.via).toBe('dashboard');

    const queue = await (await app.request('/app/', { headers: headers() })).text();
    expect(queue).toContain('Nothing waiting');
    const log = await (await app.request('/app/log?stage=human', { headers: headers() })).text();
    expect(log).toContain('banter between regulars');
    expect(log).toContain('Mo');
  });

  it('counts the override and the human share in analytics', async () => {
    const o = await overview(t.db, { since: new Date(Date.now() - 3600_000) });
    expect(o.ingested).toBe(2);
    expect(o.humanNeeded).toBe(1);
    expect(o.humanOverrides).toBe(1);
    expect(o.humanShare).toBeCloseTo(0.5);
    expect(o.s2Changed).toEqual({});
    const page = await (await app.request('/app/analytics?days=7', { headers: headers() })).text();
    expect(page).toContain('needed a human (1)');
    expect(page).toContain('fake-s1');
  });

  it('signs out and the cookie stops working', async () => {
    const res = await app.request('/app/logout', { method: 'POST', headers: headers() });
    expect(res.status).toBe(302);
    const after = await app.request('/app/', { headers: headers() });
    expect(after.status).toBe(302);
  });
});
