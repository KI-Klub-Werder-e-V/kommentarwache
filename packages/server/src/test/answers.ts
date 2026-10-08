/** Builders for answer maps in tests, so a test reads as probabilities, not JSON. */

import type { Answers } from '@kommentarwache/contract';

/** Choice answers from per-option probabilities; confidence follows the documented formula. */
export function choiceAnswers(spec: Record<string, Record<string, number>>): Answers {
  const answers: Answers = {};
  for (const [id, probabilities] of Object.entries(spec)) {
    const [choice, p] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
    const n = Object.keys(probabilities).length;
    answers[id] = { type: 'choice', choice, probabilities, confidence: (p - 1 / n) / (1 - 1 / n) };
  }
  return answers;
}

/** A full battery v2 answer set with benign defaults; override any question. */
export function v2Answers(
  overrides: Partial<
    Record<'sentiment' | 'attack' | 'target' | 'severity' | 'spam', Record<string, number>>
  > = {},
): Answers {
  return choiceAnswers({
    sentiment: overrides.sentiment ?? { positive: 0.6, neutral: 0.4, negative: 0 },
    attack: overrides.attack ?? { no_attack: 0.98, attacks_person_or_group: 0.02 },
    target: overrides.target ?? {
      nobody: 0.95,
      content_or_product: 0.05,
      other_commenter: 0,
      public_figure: 0,
      group: 0,
      self: 0,
    },
    severity: overrides.severity ?? { benign: 0.97, rude: 0.03, harassment: 0, threat: 0 },
    spam: overrides.spam ?? { not_spam: 0.99, spam_or_scam: 0.01 },
  });
}
