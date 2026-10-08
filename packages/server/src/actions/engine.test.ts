/**
 * The actions engine against a fake platform: modes, idempotency, caps, proposals,
 * undo, strikes, unsupported actions and overturned deletes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Verdict } from '@kommentarwache/contract';
import { ConnectorRegistry, FakeConnector } from '../connectors/connector.js';
import { SYSTEM_ACTOR_ID, type ConnectorActionMode } from '../db/types.js';
import { POLICIES } from '../policy/policy.js';
import { testDb, type TestDb } from '../test/db.js';
import {
  applyLadder,
  authorStrikes,
  executeProposed,
  manualAction,
  overturnDeletes,
  undoAction,
} from './engine.js';

const POLICY = POLICIES['severity_led']!;

let t: TestDb;
let connectorId: number;
let fake: FakeConnector;
let registry: ConnectorRegistry;
let modId: number;
let seq = 0;

beforeAll(async () => {
  t = await testDb();
  connectorId = (
    await t.db
      .insertInto('connectors')
      .values({ kind: 'fake', name: 'fake' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  fake = new FakeConnector();
  registry = new ConnectorRegistry().set(connectorId, fake);
  modId = (
    await t.db
      .insertInto('actors')
      .values({ type: 'moderator', name: 'Mo' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(async () => {
  await t.teardown();
});

async function setModes(
  modes: Partial<Record<'hide' | 'delete' | 'ban', ConnectorActionMode>>,
  maxPerHour: number | null = null,
) {
  await t.db.deleteFrom('connector_action_modes').where('connector_id', '=', connectorId).execute();
  for (const [action_type, mode] of Object.entries(modes)) {
    await t.db
      .insertInto('connector_action_modes')
      .values({
        connector_id: connectorId,
        action_type: action_type as 'hide',
        mode,
        max_per_hour: maxPerHour,
      })
      .execute();
  }
}

/** A comment with decisions already recorded, as the pipeline would leave it. */
async function comment(opts: {
  s1: Verdict;
  s2?: Verdict;
  category?: string;
  author?: string;
  backfill?: boolean;
  closedViolation?: boolean;
}): Promise<number> {
  const id = `c${++seq}`;
  let authorId: number | null = null;
  if (opts.author) {
    authorId = (
      await t.db
        .insertInto('authors')
        .values({ connector_id: connectorId, platform_author_id: opts.author })
        .onConflict((oc) =>
          oc
            .columns(['connector_id', 'platform_author_id'])
            .doUpdateSet({ platform_author_id: opts.author }),
        )
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }
  const c = await t.db
    .insertInto('comments')
    .values({
      connector_id: connectorId,
      platform_comment_id: id,
      author_id: authorId,
      text: `text ${id}`,
      content_hash: id,
      is_backfill: opts.backfill ?? false,
      state: opts.closedViolation ? 'closed' : 's2_pending',
      final_verdict: opts.closedViolation ? 'violation' : null,
      closed_at: opts.closedViolation ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const category = opts.category ?? 'harassment';
  await t.db
    .insertInto('decisions')
    .values({
      comment_id: c.id,
      revision: 1,
      stage: 's1',
      verdict: opts.s1,
      category,
      actor_id: SYSTEM_ACTOR_ID,
      via: 'pipeline',
    })
    .execute();
  if (opts.s2) {
    await t.db
      .insertInto('decisions')
      .values({
        comment_id: c.id,
        revision: 1,
        stage: 's2',
        verdict: opts.s2,
        category,
        actor_id: SYSTEM_ACTOR_ID,
        via: 'pipeline',
      })
      .execute();
  }
  return c.id;
}

const deps = () => ({ connectors: registry });

describe('applyLadder', () => {
  beforeEach(() => {
    fake.calls.length = 0;
  });

  it('does nothing when the mode is off, and makes no platform call in dry run', async () => {
    await setModes({});
    const off = await applyLadder(t.db, deps(), POLICY, {
      trigger: 's1',
      commentId: await comment({ s1: 'violation' }),
    });
    expect(off).toEqual([]);

    await setModes({ hide: 'dry_run' });
    const dry = await applyLadder(t.db, deps(), POLICY, {
      trigger: 's1',
      commentId: await comment({ s1: 'violation' }),
    });
    expect(dry).toMatchObject([{ type: 'hide', mode: 'dry_run', state: 'simulated' }]);
    expect(fake.calls).toEqual([]);
  });

  it('hides automatically on a stage-1 violation, exactly once however often it is applied', async () => {
    await setModes({ hide: 'auto' });
    const id = await comment({ s1: 'violation' });
    const first = await applyLadder(t.db, deps(), POLICY, { trigger: 's1', commentId: id });
    const again = await applyLadder(t.db, deps(), POLICY, { trigger: 's1', commentId: id });
    expect(first).toMatchObject([{ type: 'hide', mode: 'auto', state: 'succeeded' }]);
    expect(again).toEqual([]);
    expect(fake.calls.map((c) => c.op)).toEqual(['hide']);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('event')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(audit.event).toBe('action.succeeded');
  });

  it('proposes instead of acting, and a moderator can execute the proposal', async () => {
    await setModes({ hide: 'propose' });
    const id = await comment({ s1: 'violation' });
    const [row] = await applyLadder(t.db, deps(), POLICY, { trigger: 's1', commentId: id });
    expect(row).toMatchObject({ type: 'hide', mode: 'proposed', state: 'planned' });
    expect(fake.calls).toEqual([]);
    const item = await t.db
      .selectFrom('review_items')
      .select('reason')
      .where('comment_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(item.reason).toBe('proposed_action');

    expect(await executeProposed(t.db, deps(), row!.actionId, modId, 'dashboard')).toBe(
      'succeeded',
    );
    expect(fake.calls.map((c) => c.op)).toEqual(['hide']);
    const resolved = await t.db
      .selectFrom('review_items')
      .select('resolved_at')
      .where('comment_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(resolved.resolved_at).not.toBeNull();
  });

  it('drops to propose when the hourly cap is reached', async () => {
    await setModes({ hide: 'auto' }, 2);
    // the cap counts this connector's automatic actions of the last hour; start clean
    await t.db.deleteFrom('actions').where('connector_id', '=', connectorId).execute();
    const a = await applyLadder(t.db, deps(), POLICY, {
      trigger: 's1',
      commentId: await comment({ s1: 'violation' }),
    });
    const b = await applyLadder(t.db, deps(), POLICY, {
      trigger: 's1',
      commentId: await comment({ s1: 'violation' }),
    });
    const c = await applyLadder(t.db, deps(), POLICY, {
      trigger: 's1',
      commentId: await comment({ s1: 'violation' }),
    });
    expect([a[0]!.mode, b[0]!.mode, c[0]!.mode]).toEqual(['auto', 'auto', 'proposed']);
    const tripped = await t.db
      .selectFrom('audit_log')
      .select('event')
      .where('event', '=', 'action.cap_tripped')
      .execute();
    expect(tripped.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes and bans a confirmed threat, and a ban needs no second ban', async () => {
    await setModes({ hide: 'auto', delete: 'auto', ban: 'auto' });
    const id = await comment({
      s1: 'violation',
      s2: 'violation',
      category: 'threat',
      author: 'u-threat',
    });
    await applyLadder(t.db, deps(), POLICY, { trigger: 's1', commentId: id });
    const rows = await applyLadder(t.db, deps(), POLICY, { trigger: 's2', commentId: id });
    expect(rows.map((r) => [r.type, r.state])).toEqual([
      ['delete', 'succeeded'],
      ['ban', 'succeeded'],
    ]);
    expect(fake.banned.has('u-threat')).toBe(true);
    const author = await t.db
      .selectFrom('authors')
      .select('banned_at')
      .where('platform_author_id', '=', 'u-threat')
      .executeTakeFirstOrThrow();
    expect(author.banned_at).not.toBeNull();

    const second = await comment({
      s1: 'violation',
      s2: 'violation',
      category: 'threat',
      author: 'u-threat',
    });
    const rows2 = await applyLadder(t.db, deps(), POLICY, { trigger: 's2', commentId: second });
    expect(rows2.map((r) => r.type)).toEqual(['hide', 'delete']);
  });

  it('bans on the third confirmed violation in the window', async () => {
    await setModes({ hide: 'auto', delete: 'auto', ban: 'auto' });
    await comment({ s1: 'violation', s2: 'violation', author: 'u-strikes', closedViolation: true });
    await comment({ s1: 'violation', s2: 'violation', author: 'u-strikes', closedViolation: true });
    const third = await comment({ s1: 'violation', s2: 'violation', author: 'u-strikes' });
    const authorId = (
      await t.db
        .selectFrom('authors')
        .select('id')
        .where('platform_author_id', '=', 'u-strikes')
        .executeTakeFirstOrThrow()
    ).id;
    expect(await authorStrikes(t.db, authorId, third, 30)).toBe(2);
    const rows = await applyLadder(t.db, deps(), POLICY, { trigger: 's2', commentId: third });
    expect(rows.map((r) => r.type)).toEqual(['hide', 'ban']);
    expect(rows.find((r) => r.type === 'ban')?.rule).toMatch(/3 confirmed violations/);
  });

  it('queues a comment for a human when the platform cannot do what the ladder wants', async () => {
    const limitedId = (
      await t.db
        .insertInto('connectors')
        .values({ kind: 'fake', name: 'hide-only' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    registry.set(limitedId, new FakeConnector(['hide', 'unhide']));
    await t.db
      .insertInto('connector_action_modes')
      .values([
        { connector_id: limitedId, action_type: 'hide', mode: 'auto' },
        { connector_id: limitedId, action_type: 'delete', mode: 'auto' },
      ])
      .execute();
    const c = await t.db
      .insertInto('comments')
      .values({
        connector_id: limitedId,
        platform_comment_id: 'x1',
        text: 'x',
        content_hash: 'x1',
        state: 's2_pending',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const stage of ['s1', 's2'] as const) {
      await t.db
        .insertInto('decisions')
        .values({
          comment_id: c.id,
          revision: 1,
          stage,
          verdict: 'violation',
          category: 'threat',
          actor_id: SYSTEM_ACTOR_ID,
          via: 'pipeline',
        })
        .execute();
    }
    const rows = await applyLadder(t.db, deps(), POLICY, { trigger: 's2', commentId: c.id });
    expect(rows.map((r) => r.type)).toEqual(['hide']);
    const item = await t.db
      .selectFrom('review_items')
      .select('reason')
      .where('comment_id', '=', c.id)
      .executeTakeFirstOrThrow();
    expect(item.reason).toBe('unsupported_action');
  });

  it('undoes a hide, refuses to undo a delete, and marks deletes overturned', async () => {
    await setModes({ hide: 'auto', delete: 'auto' });
    const id = await comment({ s1: 'violation', s2: 'violation', category: 'hate' });
    const [hide] = await applyLadder(t.db, deps(), POLICY, { trigger: 's1', commentId: id });
    const undo = await undoAction(t.db, deps(), hide!.actionId, modId, 'dashboard');
    expect(undo.outcome).toBe('succeeded');
    expect(fake.calls.map((c) => c.op)).toEqual(['hide', 'unhide']);
    await expect(undoAction(t.db, deps(), hide!.actionId, modId, 'dashboard')).rejects.toThrow(
      /not an executed, un-undone/,
    );

    const rows = await applyLadder(t.db, deps(), POLICY, { trigger: 's2', commentId: id });
    const del = rows.find((r) => r.type === 'delete')!;
    await expect(undoAction(t.db, deps(), del.actionId, modId, 'dashboard')).rejects.toThrow(
      /cannot be undone/,
    );
    expect(await overturnDeletes(t.db, id, 1)).toBe(1);
  });

  it('never acts automatically on backfill, but a moderator still can', async () => {
    await setModes({ hide: 'auto', delete: 'auto', ban: 'auto' });
    const id = await comment({
      s1: 'violation',
      s2: 'violation',
      category: 'threat',
      backfill: true,
    });
    expect(await applyLadder(t.db, deps(), POLICY, { trigger: 's2', commentId: id })).toEqual([]);
    const manual = await manualAction(t.db, deps(), {
      commentId: id,
      type: 'hide',
      actorId: modId,
      via: 'dashboard',
    });
    expect(manual.outcome).toBe('succeeded');
  });

  it('records a platform failure and queues the comment', async () => {
    await setModes({ hide: 'auto' });
    fake.failNext = 'platform said no';
    const id = await comment({ s1: 'violation' });
    const [row] = await applyLadder(t.db, deps(), POLICY, { trigger: 's1', commentId: id });
    expect(row).toMatchObject({ state: 'failed' });
    const item = await t.db
      .selectFrom('review_items')
      .select('reason')
      .where('comment_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(item.reason).toBe('action_failed');
  });
});
