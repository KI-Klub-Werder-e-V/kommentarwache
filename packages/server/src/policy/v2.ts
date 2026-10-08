/**
 * Routing for battery v2 (choice-only). Pure code, no model calls.
 *
 * Severity is read as the expected level over benign / rude / harassment / threat, so
 * the same numbers as v1 apply. The attack probability only earns a second look; the
 * severity scale decides violations. Spam is its own track.
 */

import {
  higherVerdict,
  type Answers,
  type Category,
  type ChoiceAnswer,
  type Policy,
  type Routing,
  type Verdict,
} from '@kommentarwache/contract';
import { SEVERITY_LEVELS } from '../batteries/v2.js';

export interface V2Answers {
  sentiment: ChoiceAnswer;
  attack: ChoiceAnswer;
  target: ChoiceAnswer;
  severity: ChoiceAnswer;
  spam: ChoiceAnswer;
}

export function toV2Answers(answers: Answers): V2Answers {
  const pick = (id: keyof V2Answers): ChoiceAnswer => {
    const a = answers[id];
    if (a?.type !== 'choice') throw new Error(`battery v2 needs a choice answer "${id}"`);
    return a;
  };
  return {
    sentiment: pick('sentiment'),
    attack: pick('attack'),
    target: pick('target'),
    severity: pick('severity'),
    spam: pick('spam'),
  };
}

/** Expected severity level: sum of P(level) times its index, 0 (benign) to 3 (threat). */
export function expectedSeverity(severity: ChoiceAnswer): number {
  return SEVERITY_LEVELS.reduce(
    (acc, level, i) => acc + (severity.probabilities[level] ?? 0) * i,
    0,
  );
}

function severityCategory(a: V2Answers): Category {
  switch (a.severity.choice) {
    case 'threat':
      return 'threat';
    case 'harassment':
      return a.target.choice === 'group' ? 'hate' : 'harassment';
    case 'rude':
      return 'rude';
    default:
      return 'other';
  }
}

export function routeV2(a: V2Answers, policy: Policy): Routing {
  const t = policy.v2;
  let verdict: Verdict = 'ok';
  let category: Category = 'none';
  const reasons: string[] = [];

  const raiseTo = (level: Verdict, cat: Category, reason: string) => {
    reasons.push(reason);
    const next = higherVerdict(verdict, level);
    if (next !== verdict || category === 'none') category = cat;
    verdict = next;
  };

  const pAttack = a.attack.probabilities['attacks_person_or_group'] ?? 0;
  const sev = expectedSeverity(a.severity);
  const pSpam = a.spam.probabilities['spam_or_scam'] ?? 0;
  const rudeTowardPublicFigure =
    t.tolerateRudeTowardPublicFigure &&
    a.target.choice === 'public_figure' &&
    a.severity.choice !== 'harassment' &&
    a.severity.choice !== 'threat';

  if (sev >= t.severityViolation) {
    raiseTo(
      'violation',
      severityCategory(a),
      `severity ${fmt(sev)} >= ${fmt(t.severityViolation)}`,
    );
  } else if (sev >= t.severityUnsure) {
    if (rudeTowardPublicFigure) {
      reasons.push(`severity ${fmt(sev)} toward a public figure tolerated`);
    } else {
      raiseTo('unsure', severityCategory(a), `severity ${fmt(sev)} >= ${fmt(t.severityUnsure)}`);
    }
  }

  if (t.attackViolation !== null && pAttack >= t.attackViolation) {
    raiseTo(
      'violation',
      severityCategory(a),
      `attack ${fmt(pAttack)} >= ${fmt(t.attackViolation)}`,
    );
  } else if (pAttack >= t.attackUnsure) {
    if (rudeTowardPublicFigure) {
      reasons.push(`attack ${fmt(pAttack)} toward a public figure tolerated`);
    } else {
      raiseTo('unsure', 'rude', `attack ${fmt(pAttack)} >= ${fmt(t.attackUnsure)}`);
    }
  }

  if (pSpam >= t.spamViolation) {
    raiseTo('violation', 'spam', `spam ${fmt(pSpam)} >= ${fmt(t.spamViolation)}`);
  } else if (pSpam >= t.spamUnsure) {
    raiseTo('unsure', 'spam', `spam ${fmt(pSpam)} >= ${fmt(t.spamUnsure)}`);
  }

  if (verdict === 'ok') category = 'none';
  return { verdict, category, reasons };
}

function fmt(n: number): string {
  return n.toFixed(2);
}
