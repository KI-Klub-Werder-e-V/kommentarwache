/**
 * Agent parity: every command in the catalogue is reachable as a REST route and as an
 * MCP tool, under the same scopes, and is attributed to the token that called it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMANDS, COMMAND_NAMES } from '@kommentarwache/contract';
import { createApp } from '../api/app.js';
import { createApiToken } from '../api/auth.js';
import { BATTERY_V2 } from '../batteries/v2.js';
import { ConnectorRegistry, FakeConnector } from '../connectors/connector.js';
import { createMcpServer } from '../mcp/server.js';
import { ingestComment } from '../pipeline/ingest.js';
import { runStage1 } from '../pipeline/stage1.js';
import { POLICIES } from '../policy/policy.js';
import type { AssessOutcome, DecisionProvider } from '../providers/provider.js';
import type { ActivePipeline } from '../providers/registry.js';
import { v2Answers } from '../test/answers.js';
import { testDb, type TestDb } from '../test/db.js';

const POLICY = POLICIES['severity_led']!;

let t: TestDb;
let app: ReturnType<typeof createApp>;
let pipeline: ActivePipeline;
let reviewer: string;
let admin: string;
let connectorId: number;
let violationId: number;

beforeAll(async () => {
  t = await testDb();
  connectorId = (
    await t.db
      .insertInto('connectors')
      .values({ kind: 'fake', name: 'fake' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  for (const action_type of ['hide', 'delete', 'ban'] as const) {
    await t.db
      .insertInto('connector_action_modes')
      .values({ connector_id: connectorId, action_type, mode: 'auto' })
      .execute();
  }
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
  const pc = await t.db
    .insertInto('pipeline_configs')
    .values({ version: 1, s1_primary: p1.id, policy_id: policy.id, activated_at: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow();

  const provider: DecisionProvider = {
    configId: p1.id,
    name: 'fake-s1',
    kind: 'systemone',
    battery: BATTERY_V2,
    assess: async (input): Promise<AssessOutcome> => ({
      status: 'ok',
      latencyMs: 1,
      modelVersion: 'fake-1',
      answers: input.text.includes('idiot')
        ? v2Answers({
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
          })
        : v2Answers(),
    }),
  };
  const connectors = new ConnectorRegistry().set(connectorId, new FakeConnector());
  pipeline = {
    pipelineConfigId: pc.id,
    provider,
    batteryId: battery.id,
    mapper: 'v2',
    policy: POLICY,
    policyId: policy.id,
    connectors,
    enqueueStage2: async () => {},
    afterDecision: async () => {},
  };
  app = createApp({ db: t.db, pipeline: async () => pipeline });
  reviewer = (await createApiToken(t.db, { name: 'agent', scopes: ['moderate', 'review'] })).token;
  admin = (await createApiToken(t.db, { name: 'admin', scopes: ['*'] })).token;

  violationId = (
    await ingestComment(t.db, {
      connectorId,
      platformCommentId: 'v1',
      text: 'you idiot',
      authorRef: 'u1',
    })
  ).commentId;
  await runStage1(t.db, pipeline, violationId);
});
afterAll(async () => {
  await t.teardown();
});

const call = (method: string, path: string, token: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe('parity', () => {
  it('exposes every command as an MCP tool with its description', async () => {
    const server = createMcpServer({
      db: t.db,
      pipeline: async () => pipeline,
      actor: { id: 1, type: 'system', name: 'pipeline', scopes: ['*'] },
    });
    // the SDK keeps registered tools privately; list them through the protocol
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual([...COMMAND_NAMES].sort());
    for (const tool of tools.tools)
      expect(tool.description).toBe(COMMANDS[tool.name as keyof typeof COMMANDS].description);
    const res = await client.callTool({ name: 'list_queue', arguments: { limit: 5 } });
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toHaveProperty('items');
    await client.close();
    await server.close();
  });

  it('exposes every command as a REST route that is not 404', async () => {
    const sample: Record<string, unknown> = {
      moderate_comment: { source: 'fake', id: 'p1', text: 'fine' },
      get_comment: { id: violationId },
      decide_comment: { id: violationId, verdict: 'ok' },
      act_on_comment: { id: violationId, op: 'hide' },
      replay_policy: { source: 'fake', policy: 'strict' },
      set_source_modes: { id: connectorId, hide: 'auto', delete: 'propose', ban: 'off' },
    };
    for (const name of COMMAND_NAMES) {
      const spec = COMMANDS[name];
      const input = (sample[name] ?? {}) as Record<string, unknown>;
      const path = spec.path.replace(/:(\w+)/g, (_, k: string) => String(input[k]));
      const res = await call(spec.method, path, admin, spec.method === 'GET' ? undefined : input);
      expect(res.status, `${name} ${spec.method} ${path}`).not.toBe(404);
      expect(res.status, `${name}: ${await res.clone().text()}`).toBeLessThan(500);
    }
  });

  it('enforces scopes: a review token cannot set modes, and its delete becomes a proposal', async () => {
    const denied = await call('PUT', `/v1/sources/${connectorId}/modes`, reviewer, {
      hide: 'off',
      delete: 'off',
      ban: 'off',
    });
    expect(denied.status).toBe(403);

    const id = (
      await ingestComment(t.db, {
        connectorId,
        platformCommentId: 'v2',
        text: 'you idiot again',
        authorRef: 'u2',
      })
    ).commentId;
    await runStage1(t.db, pipeline, id);
    const res = await call('POST', `/v1/comments/${id}/actions`, reviewer, { op: 'delete' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposed).toBe(true);
    const action = await t.db
      .selectFrom('actions')
      .selectAll()
      .where('id', '=', body.actionId)
      .executeTakeFirstOrThrow();
    expect(action).toMatchObject({ mode: 'proposed', state: 'planned', via: 'api' });
    const item = await t.db
      .selectFrom('review_items')
      .select('reason')
      .where('comment_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(item.reason).toBe('proposed_action');

    const executed = await call('POST', `/v1/comments/${id}/actions`, reviewer, {
      op: `execute:${body.actionId}`,
    });
    expect(executed.status).toBe(403);
    const byAdmin = await call('POST', `/v1/comments/${id}/actions`, admin, {
      op: `execute:${body.actionId}`,
    });
    expect(await byAdmin.json()).toMatchObject({ outcome: 'succeeded' });
  });

  it('attributes agent decisions to the token', async () => {
    const id = (await ingestComment(t.db, { connectorId, platformCommentId: 'v3', text: 'hm' }))
      .commentId;
    await runStage1(t.db, pipeline, id);
    const res = await call('POST', `/v1/comments/${id}/decide`, reviewer, {
      verdict: 'violation',
      category: 'rude',
      note: 'agent says so',
    });
    expect(res.status).toBe(200);
    const d = await t.db
      .selectFrom('decisions')
      .innerJoin('actors', 'actors.id', 'decisions.actor_id')
      .select(['actors.name', 'actors.type', 'decisions.via'])
      .where('decisions.comment_id', '=', id)
      .where('decisions.stage', '=', 'human')
      .executeTakeFirstOrThrow();
    expect(d).toEqual({ name: 'agent', type: 'agent', via: 'api' });
  });

  it('answers MCP over HTTP under a bearer token', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reviewer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('kommentarwache');
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(401);
  });
});
