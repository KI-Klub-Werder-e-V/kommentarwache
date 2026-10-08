/**
 * Routing for score-style providers: Llama Guard (one P(unsafe) plus a category) and
 * OpenAI moderation (a score per category). Pure code; thresholds from the policy.
 */

import type {
  Answers,
  Category,
  Policy,
  Routing,
  ScoreThresholds,
  Verdict,
} from '@kommentarwache/contract';

const GUARD_CATEGORY: Record<string, Category> = {
  S1: 'harassment',
  S2: 'hate',
  S3: 'threat',
  S4: 'spam',
};

function verdictFor(p: number, t: ScoreThresholds): Verdict {
  return p >= t.violation ? 'violation' : p >= t.unsure ? 'unsure' : 'ok';
}

export function routeGuard(answers: Answers, policy: Policy): Routing {
  const unsafe = answers['unsafe'];
  if (unsafe?.type !== 'noul') throw new Error('guard mapper needs a noul answer "unsafe"');
  const cat = answers['category'];
  const code = cat?.type === 'choice' ? cat.choice : 'none';
  const verdict = verdictFor(unsafe.noul, policy.guard);
  const category: Category = verdict === 'ok' ? 'none' : (GUARD_CATEGORY[code] ?? 'other');
  const reasons =
    verdict === 'ok'
      ? []
      : [
          `unsafe ${unsafe.noul.toFixed(2)} >= ${(verdict === 'violation' ? policy.guard.violation : policy.guard.unsure).toFixed(2)}${code !== 'none' ? ` (${code})` : ''}`,
        ];
  return { verdict, category, reasons };
}

/** OpenAI's categories mapped onto ours; sexual and self-harm scores count as "other". */
const OPENAI_CATEGORY: Array<[RegExp, Category]> = [
  [/threatening|violence|illicit_violent/, 'threat'],
  [/^hate/, 'hate'],
  [/^harassment/, 'harassment'],
  [/sexual|self_harm/, 'other'],
];

export function routeOpenAI(answers: Answers, policy: Policy): Routing {
  let best: { id: string; p: number; category: Category } | undefined;
  for (const [id, a] of Object.entries(answers)) {
    if (a.type !== 'noul') continue;
    const category = OPENAI_CATEGORY.find(([re]) => re.test(id))?.[1];
    if (!category) continue;
    if (!best || a.noul > best.p) best = { id, p: a.noul, category };
  }
  if (!best) return { verdict: 'ok', category: 'none', reasons: [] };
  const verdict = verdictFor(best.p, policy.openai);
  return {
    verdict,
    category: verdict === 'ok' ? 'none' : best.category,
    reasons:
      verdict === 'ok'
        ? []
        : [
            `${best.id} ${best.p.toFixed(2)} >= ${(verdict === 'violation' ? policy.openai.violation : policy.openai.unsure).toFixed(2)}`,
          ],
  };
}
