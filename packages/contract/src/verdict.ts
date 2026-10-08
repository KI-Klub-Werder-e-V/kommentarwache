import { z } from 'zod';

/**
 * Every stage of the pipeline answers in this one vocabulary, whichever model produced
 * the answers. `unsure` is the band that earns a second opinion, then a human.
 */
export const VerdictSchema = z.enum(['ok', 'unsure', 'violation']);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Ordered by precedence: a verdict never downgrades when reasons accumulate. */
export const VERDICT_ORDER: readonly Verdict[] = ['ok', 'unsure', 'violation'];

export function higherVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_ORDER.indexOf(a) >= VERDICT_ORDER.indexOf(b) ? a : b;
}

/**
 * What kind of violation. `none` goes with `ok`. The delete and ban rules in the policy
 * refer to these names, so they are part of the contract.
 */
export const CategorySchema = z.enum([
  'none',
  'rude',
  'harassment',
  'hate',
  'threat',
  'doxxing',
  'spam',
  'scam',
  'other',
]);
export type Category = z.infer<typeof CategorySchema>;

/** One routed result: verdict, category and the human-readable reasons that produced it. */
export const RoutingSchema = z.object({
  verdict: VerdictSchema,
  category: CategorySchema,
  reasons: z.array(z.string()),
});
export type Routing = z.infer<typeof RoutingSchema>;

/**
 * The prototype in the Typesafe repo used approve / review / flag. Kept for importing
 * its results and for reporting against its labelled sets.
 */
export const LegacyVerdictSchema = z.enum(['approve', 'review', 'flag']);
export type LegacyVerdict = z.infer<typeof LegacyVerdictSchema>;

const LEGACY_TO_VERDICT: Record<LegacyVerdict, Verdict> = {
  approve: 'ok',
  review: 'unsure',
  flag: 'violation',
};
const VERDICT_TO_LEGACY: Record<Verdict, LegacyVerdict> = {
  ok: 'approve',
  unsure: 'review',
  violation: 'flag',
};

export function fromLegacyVerdict(v: LegacyVerdict): Verdict {
  return LEGACY_TO_VERDICT[v];
}

export function toLegacyVerdict(v: Verdict): LegacyVerdict {
  return VERDICT_TO_LEGACY[v];
}
