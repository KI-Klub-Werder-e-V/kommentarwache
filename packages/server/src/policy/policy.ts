/**
 * Turn one comment's answers into a verdict. Pure code, no model calls.
 *
 * The model supplies calibrated probabilities; this file owns the decision. Change a
 * threshold here and replay saved assessments without paying for inference again.
 * Ported from the prototype's policy.py in the Typesafe repo.
 */

import {
  higherVerdict,
  type Answers,
  type Category,
  type Policy,
  type Routing,
  type V1Thresholds,
  type Verdict,
} from '@kommentarwache/contract';

/** The prototype's four named policies, in the new vocabulary. */
export const POLICIES: Record<string, Policy> = {
  // Default. Hostility alone only earns a second look; the graded severity scale decides
  // what is a violation. Mild rudeness is unsure, harassment and threats are violations.
  severity_led: {
    name: 'severity_led',
    v1: {
      hostileViolation: null,
      hostileUnsure: 0.35,
      severityViolation: 1.5,
      severityUnsure: 1.0,
      minConfidence: 0.6,
      flagNegativeSentiment: false,
    },
  },
  strict: {
    name: 'strict',
    v1: {
      hostileViolation: 0.7,
      hostileUnsure: 0.35,
      severityViolation: 2.0,
      severityUnsure: 1.0,
      minConfidence: 0.6,
      flagNegativeSentiment: false,
    },
  },
  permissive: {
    name: 'permissive',
    v1: {
      hostileViolation: 0.85,
      hostileUnsure: 0.5,
      severityViolation: 2.0,
      severityUnsure: 1.5,
      minConfidence: 0.6,
      flagNegativeSentiment: false,
    },
  },
  // What "flag negative comments" literally means. Kept to show what it gets wrong.
  naive: {
    name: 'naive',
    v1: {
      hostileViolation: 0.7,
      hostileUnsure: 0.35,
      severityViolation: 2.0,
      severityUnsure: 1.0,
      minConfidence: 0.6,
      flagNegativeSentiment: true,
    },
  },
};
export const DEFAULT_POLICY = 'severity_led';

/** The answers battery v1 produces. Question ids match the prototype's questions.py. */
export interface V1Answers {
  sentiment: { choice: string; confidence: number };
  hostile: { noul: number };
  target: { choice: string; confidence: number };
  severity: { score: number };
}

/** Narrow the generic answer map to what the v1 router needs, or explain what is missing. */
export function toV1Answers(answers: Answers): V1Answers {
  const sentiment = answers['sentiment'];
  const hostile = answers['hostile'];
  const target = answers['target'];
  const severity = answers['severity'];
  if (sentiment?.type !== 'choice') throw new Error('battery v1 needs a choice answer "sentiment"');
  if (hostile?.type !== 'noul') throw new Error('battery v1 needs a noul answer "hostile"');
  if (target?.type !== 'choice') throw new Error('battery v1 needs a choice answer "target"');
  if (severity?.type !== 'score') throw new Error('battery v1 needs a score answer "severity"');
  return { sentiment, hostile, target, severity };
}

/** The sentiment label to report. Low confidence becomes "uncertain" rather than a guess. */
export function labelSentiment(a: V1Answers, t: V1Thresholds): string {
  return a.sentiment.confidence >= t.minConfidence ? a.sentiment.choice : 'uncertain';
}

/** Severity levels 0 to 3 map onto categories; a group target turns harassment into hate. */
function categoryFor(a: V1Answers, verdict: Verdict): Category {
  if (verdict === 'ok') return 'none';
  const level = Math.round(a.severity.score);
  if (level >= 3) return 'threat';
  if (level >= 2) return a.target.choice === 'group' ? 'hate' : 'harassment';
  if (level >= 1 || a.hostile.noul > 0) return 'rude';
  return 'other';
}

/** One verdict per comment plus the human-readable reasons that produced it. */
export function routeV1(a: V1Answers, policy: Policy): Routing {
  const t = policy.v1;
  let verdict: Verdict = 'ok';
  const reasons: string[] = [];

  const raiseTo = (level: Verdict, reason: string) => {
    reasons.push(reason);
    verdict = higherVerdict(verdict, level);
  };

  if (t.hostileViolation !== null && a.hostile.noul >= t.hostileViolation) {
    raiseTo('violation', `hostile ${fmt(a.hostile.noul)} >= ${fmt(t.hostileViolation)}`);
  } else if (a.hostile.noul >= t.hostileUnsure) {
    raiseTo('unsure', `hostile ${fmt(a.hostile.noul)} >= ${fmt(t.hostileUnsure)}`);
  }

  if (a.severity.score >= t.severityViolation) {
    raiseTo('violation', `severity ${fmt(a.severity.score)} >= ${fmt(t.severityViolation)}`);
  } else if (a.severity.score >= t.severityUnsure) {
    raiseTo('unsure', `severity ${fmt(a.severity.score)} >= ${fmt(t.severityUnsure)}`);
  }

  if (t.flagNegativeSentiment && a.sentiment.choice === 'negative') {
    raiseTo('violation', 'sentiment is negative (naive policy)');
  }

  return { verdict, category: categoryFor(a, verdict), reasons };
}

function fmt(n: number): string {
  return n.toFixed(2);
}
