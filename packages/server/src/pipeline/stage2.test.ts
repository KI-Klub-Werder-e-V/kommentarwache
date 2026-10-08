import type { Verdict } from '@kommentarwache/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BATTERY_V2 } from '../batteries/v2.js';
import { POLICIES } from '../policy/policy.js';
import type { JudgeInput, JudgeOutcome, JudgeProvider } from '../providers/llmjudge.js';
import type { AssessOutcome, DecisionProvider, ModerationInput } from '../providers/provider.js';
import { v2Answers } from '../test/answers.js';
import { testDb, type TestDb } from '../test/db.js';
import { ingestComment } from './ingest.js';
import { reconcileDeadlines } from './reconcile.js';
import { runStage1, type Stage1Context } from './stage1.js';
import { acceptJudge, combine, runStage2, type Stage2Context } from './stage2.js';

const POLICY = POLICIES['severity_led']!;

class Stage1Fake implements DecisionProvider {
  readonly kind = 'systemone' as const;
  readonly battery = BATTERY_V2;
  constructor(
    readonly configId: number,
    readonly name: string,
  ) {}
  async assess(input: ModerationInput): Promise<AssessOutcome> {
    const violation = input.text.includes('VIOLATION');
    const unsure = input.text.includes('UNSURE');
    return {
      status: 'ok',
      latencyMs: 1,
      answers: v2Answers(
        violation
          ? {
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
            }
          : unsure
            ? {
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
              }
            : {},
      ),
    };
  }
}

/** Scripted by a marker in the text: `s2=ok:0.9`, `s2=violation:0.6`, `s2=fail`. */
class JudgeFake implements JudgeProvider {
  calls = 0;
  constructor(
    readonly configId: number,
    readonly name: string,
  ) {}
  async judge(input: JudgeInput): Promise<JudgeOutcome> {
    this.calls++;
    const m = /s2=(ok|unsure|violation|fail)(?::([\d.]+))?/.exec(input.text);
    if (!m || m[1] === 'fail') return { status: 'error', latencyMs: 1, error: 'judge down' };
    const verdict = m[1] as Verdict;
    const p = Number(m[2] ?? 0.9);
    const rest = (1 - p) / 2;
    const probabilities = { ok: rest, unsure: rest, violation: rest, [verdict]: p } as Record<
      Verdict,
      number
    >;
    return {
      status: 'ok',
      verdict,
      category: verdict === 'violation' ? 'harassment' : verdict === 'ok' ? 'none' : 'rude',
      probabilities,
      confidenceSource: 'logprobs',
      rationale: 'scripted',
      answers: {
        verdict: { type: 'choice', choice: verdict, probabilities, confidence: p },
        category: {
          type: 'choice',
          choice: 'harassment',
          probabilities: { harassment: 1 },
          confidence: 1,
        },
      },
      modelVersion: 'fake-judge',
      latencyMs: 1,
    };
  }
}

let t: TestDb;
let connectorId: number;
let s1: Stage1Context;
let s2: Stage2Context;
let judge: JudgeFake;
const enqueued: Array<{ commentId: number; verdict: Verdict }> = [];

beforeAll(async () => {
  t = await testDb();
  connectorId = (
    await t.db
      .insertInto('connectors')
      .values({ kind: 'test', name: 'fake' })
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
  judge = new JudgeFake(p2.id, 'fake-s2');
  s1 = {
    provider: new Stage1Fake(p1.id, 'fake-s1'),
    batteryId: battery.id,
    mapper: 'v2',
    policy: POLICY,
    policyId: policy.id,
    enqueueStage2: async (_trx, job) => {
      enqueued.push({ commentId: job.commentId, verdict: job.verdict });
    },
  };
  s2 = { judge, policy: POLICY, policyId: policy.id };
});
afterAll(async () => {
  await t.teardown();
});

async function through(id: string, text: string) {
  const { commentId } = await ingestComment(t.db, { connectorId, platformCommentId: id, text });
  await runStage1(t.db, s1, commentId);
  return commentId;
}

describe('combine and acceptJudge', () => {
  it('follows the architecture table', () => {
    expect(combine('violation', 'violation')).toEqual({ outcome: 'closed', final: 'violation' });
    expect(combine('violation', 'ok')).toEqual({
      outcome: 'human',
      reviewReason: 'stage_disagree',
    });
    expect(combine('violation', 'unsure')).toEqual({
      outcome: 'human',
      reviewReason: 'stage_disagree',
    });
    expect(combine('unsure', 'ok')).toEqual({ outcome: 'closed', final: 'ok' });
    expect(combine('unsure', 'violation')).toEqual({ outcome: 'closed', final: 'violation' });
    expect(combine('unsure', 'unsure')).toEqual({ outcome: 'human', reviewReason: 'both_unsure' });
  });

  it('accepts a verdict only above the confidence line', () => {
    expect(acceptJudge('violation', { ok: 0.1, unsure: 0.1, violation: 0.8 }, POLICY)).toBe(
      'violation',
    );
    expect(acceptJudge('violation', { ok: 0.2, unsure: 0.2, violation: 0.6 }, POLICY)).toBe(
      'unsure',
    );
    expect(acceptJudge('ok', { ok: 0.95, unsure: 0.05, violation: 0 }, POLICY)).toBe('ok');
    expect(acceptJudge('unsure', { ok: 0.1, unsure: 0.8, violation: 0.1 }, POLICY)).toBe('unsure');
  });
});

describe('stage 1 to stage 2', () => {
  it('queues a stage-2 job with a deadline for an unsure comment and none for ok', async () => {
    const okId = await through('ok1', 'nice one');
    const unsureId = await through('u1', 'UNSURE s2=ok:0.9');
    expect(enqueued.find((e) => e.commentId === okId)).toBeUndefined();
    expect(enqueued.find((e) => e.commentId === unsureId)).toMatchObject({ verdict: 'unsure' });
    const row = await t.db
      .selectFrom('comments')
      .select(['state', 'state_deadline_at'])
      .where('id', '=', unsureId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('s2_pending');
    expect(row.state_deadline_at!.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
  });

  it('closes an unsure comment the judge is confident is ok', async () => {
    const id = await through('u2', 'UNSURE s2=ok:0.9');
    const r = await runStage2(t.db, s2, id);
    expect(r).toMatchObject({
      s1Verdict: 'unsure',
      s2Verdict: 'ok',
      outcome: 'closed',
      cached: false,
    });
    const row = await t.db
      .selectFrom('comments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      state: 'closed',
      final_verdict: 'ok',
      final_category: 'none',
      final_stage: 's2',
    });
    const again = await runStage2(t.db, s2, id);
    expect(again.cached).toBe(true);
  });

  it('sends a comment to a human when both stages are unsure', async () => {
    const id = await through('u3', 'UNSURE s2=unsure:0.8');
    const r = await runStage2(t.db, s2, id);
    expect(r).toMatchObject({ outcome: 'human', reviewReason: 'both_unsure' });
    const item = await t.db
      .selectFrom('review_items')
      .selectAll()
      .where('comment_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(item.resolved_at).toBeNull();
    const row = await t.db
      .selectFrom('comments')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('human_pending');
  });

  it('treats a low-confidence judge verdict as unsure', async () => {
    const id = await through('u4', 'UNSURE s2=violation:0.6');
    const r = await runStage2(t.db, s2, id);
    expect(r.s2Verdict).toBe('unsure');
    expect(r.outcome).toBe('human');
  });

  it('confirms a stage-1 violation and closes it', async () => {
    const id = await through('v1', 'VIOLATION s2=violation:0.9');
    const r = await runStage2(t.db, s2, id);
    expect(r).toMatchObject({
      s1Verdict: 'violation',
      s2Verdict: 'violation',
      outcome: 'closed',
      category: 'harassment',
    });
    const row = await t.db
      .selectFrom('comments')
      .select(['final_verdict', 'final_stage'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ final_verdict: 'violation', final_stage: 's2' });
  });

  it('sends a stage-1 violation the judge disputes to a human', async () => {
    const id = await through('v2', 'VIOLATION s2=ok:0.9');
    const r = await runStage2(t.db, s2, id);
    expect(r).toMatchObject({ outcome: 'human', reviewReason: 'stage_disagree' });
    const item = await t.db
      .selectFrom('review_items')
      .select('priority')
      .where('comment_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(item.priority).toBe(10);
  });

  it('records a judge failure and leaves the comment pending for a retry', async () => {
    const id = await through('f1', 'UNSURE s2=fail');
    await expect(runStage2(t.db, s2, id)).rejects.toThrow(/judge down/);
    const row = await t.db
      .selectFrom('comments')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('s2_pending');
  });

  it('moves overdue comments to the human queue', async () => {
    const id = await through('d1', 'UNSURE s2=ok:0.9');
    await t.db
      .updateTable('comments')
      .set({ state_deadline_at: new Date(Date.now() - 1000) })
      .where('id', '=', id)
      .execute();
    const result = await reconcileDeadlines(t.db);
    expect(result.timedOut).toBeGreaterThanOrEqual(1);
    const item = await t.db
      .selectFrom('review_items')
      .select('reason')
      .where('comment_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(item.reason).toBe('s2_timeout');
    // a late stage-2 run must not reopen it
    await expect(runStage2(t.db, s2, id)).rejects.toThrow(/not waiting for stage 2/);
  });
});
