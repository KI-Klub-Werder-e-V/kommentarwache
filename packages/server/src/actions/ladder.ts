/**
 * The action ladder, as pure code. What may happen to a comment after a verdict depends
 * on which stage decided, whether the stages agree, the category, and the author's
 * record. Reversibility sets the bar: hide on stage 1 alone, delete and ban only with
 * stage 2's agreement. The connector's abilities and modes are applied afterwards.
 */

import type { ActionsPolicy, Verdict } from '@kommentarwache/contract';

export type LadderAction = 'hide' | 'unhide' | 'delete' | 'ban';

export interface LadderInput {
  /** which decision just happened */
  trigger: 's1' | 's2' | 'human';
  s1Verdict: Verdict;
  s2Verdict?: Verdict | undefined;
  humanVerdict?: Verdict | undefined;
  /** the category of the triggering decision */
  category: string;
  isBackfill: boolean;
  authorAllowlisted: boolean;
  /** confirmed violations by this author in the window, not counting this comment */
  authorStrikes: number;
  hidden: boolean;
  banned: boolean;
}

export interface PlannedAction {
  type: LadderAction;
  rule: string;
}

export function ladder(i: LadderInput, p: ActionsPolicy): PlannedAction[] {
  const out: PlannedAction[] = [];

  if (i.trigger === 'human') {
    // A moderator's verdict is explicit, so allow-lists and backfill do not hold it back.
    if (i.humanVerdict === 'violation' && !i.hidden)
      out.push({ type: 'hide', rule: 'human: violation' });
    if (i.humanVerdict === 'ok' && i.hidden)
      out.push({ type: 'unhide', rule: 'human: ok, undo the hide' });
    return out;
  }

  // Nothing automatic for imported history or trusted authors.
  if (i.isBackfill || i.authorAllowlisted) return out;

  if (i.trigger === 's1') {
    if (i.s1Verdict === 'violation' && !i.hidden)
      out.push({ type: 'hide', rule: 'stage 1: violation' });
    return out;
  }

  // trigger s2
  if (i.s2Verdict !== 'violation') return out;
  if (!i.hidden) out.push({ type: 'hide', rule: 'stage 2: violation' });
  if (i.s1Verdict !== 'violation') return out; // s1 unsure: hide at most

  const confirmed = `both stages: ${i.category}`;
  if (p.deleteCategories.includes(i.category as never))
    out.push({ type: 'delete', rule: confirmed });
  if (i.banned) return out;
  if (p.banCategories.includes(i.category as never)) {
    out.push({ type: 'ban', rule: confirmed });
  } else if (i.authorStrikes + 1 >= p.strikesForBan) {
    out.push({
      type: 'ban',
      rule: `${i.authorStrikes + 1} confirmed violations in ${p.strikeWindowDays} days`,
    });
  }
  return out;
}
