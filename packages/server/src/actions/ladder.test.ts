import { describe, expect, it } from 'vitest';
import { ACTIONS_DEFAULT } from '../policy/policy.js';
import { ladder, type LadderInput } from './ladder.js';

const base: LadderInput = {
  trigger: 's1',
  s1Verdict: 'violation',
  category: 'harassment',
  isBackfill: false,
  authorAllowlisted: false,
  authorStrikes: 0,
  hidden: false,
  banned: false,
};
const types = (i: Partial<LadderInput>) =>
  ladder({ ...base, ...i }, ACTIONS_DEFAULT).map((a) => a.type);

describe('ladder', () => {
  it('hides on a stage-1 violation and nothing more', () => {
    expect(types({})).toEqual(['hide']);
    expect(types({ hidden: true })).toEqual([]);
  });

  it('does nothing on stage 1 for unsure or ok', () => {
    expect(types({ s1Verdict: 'unsure' })).toEqual([]);
    expect(types({ s1Verdict: 'ok' })).toEqual([]);
  });

  it('never acts automatically on backfill or allow-listed authors', () => {
    expect(types({ isBackfill: true })).toEqual([]);
    expect(types({ authorAllowlisted: true, trigger: 's2', s2Verdict: 'violation' })).toEqual([]);
  });

  it('after stage 2: harassment confirmed is hidden only', () => {
    expect(types({ trigger: 's2', s2Verdict: 'violation', hidden: true })).toEqual([]);
    expect(types({ trigger: 's2', s2Verdict: 'violation' })).toEqual(['hide']);
  });

  it('after stage 2: a confirmed threat is deleted and the author banned', () => {
    expect(
      types({ trigger: 's2', s2Verdict: 'violation', category: 'threat', hidden: true }),
    ).toEqual(['delete', 'ban']);
    expect(
      types({
        trigger: 's2',
        s2Verdict: 'violation',
        category: 'threat',
        hidden: true,
        banned: true,
      }),
    ).toEqual(['delete']);
  });

  it('after stage 2: hate is deleted but not banned on the first strike', () => {
    expect(
      types({ trigger: 's2', s2Verdict: 'violation', category: 'hate', hidden: true }),
    ).toEqual(['delete']);
  });

  it('bans on the third confirmed violation', () => {
    expect(
      types({ trigger: 's2', s2Verdict: 'violation', hidden: true, authorStrikes: 2 }),
    ).toEqual(['ban']);
    expect(
      ladder(
        { ...base, trigger: 's2', s2Verdict: 'violation', hidden: true, authorStrikes: 2 },
        ACTIONS_DEFAULT,
      )[0]?.rule,
    ).toMatch(/3 confirmed violations in 30 days/);
    expect(
      types({ trigger: 's2', s2Verdict: 'violation', hidden: true, authorStrikes: 1 }),
    ).toEqual([]);
  });

  it('stage 1 unsure plus stage 2 violation hides at most', () => {
    expect(
      types({ trigger: 's2', s1Verdict: 'unsure', s2Verdict: 'violation', category: 'threat' }),
    ).toEqual(['hide']);
  });

  it('stage 2 ok or unsure takes no action', () => {
    expect(types({ trigger: 's2', s2Verdict: 'ok' })).toEqual([]);
    expect(types({ trigger: 's2', s2Verdict: 'unsure' })).toEqual([]);
  });

  it('human verdicts hide or undo a hide, even for allow-listed authors', () => {
    expect(types({ trigger: 'human', humanVerdict: 'violation', authorAllowlisted: true })).toEqual(
      ['hide'],
    );
    expect(types({ trigger: 'human', humanVerdict: 'ok', hidden: true })).toEqual(['unhide']);
    expect(types({ trigger: 'human', humanVerdict: 'ok' })).toEqual([]);
  });
});
