import { z } from 'zod';

/**
 * Thresholds for routing battery v1 answers (sentiment, hostile, target, severity).
 * Ported from the prototype's policy.py. Probabilities are 0 to 1; severity is the
 * expected level on the 0 to 3 scale Benign / Rude / Harassment / Threat.
 */
export const V1ThresholdsSchema = z.object({
  /** hostile probability at or above this is a violation; null disables */
  hostileViolation: z.number().min(0).max(1).nullable(),
  /** hostile probability at or above this is unsure */
  hostileUnsure: z.number().min(0).max(1),
  /** severity score at or above this is a violation */
  severityViolation: z.number().min(0).max(3),
  /** severity score at or above this is unsure */
  severityUnsure: z.number().min(0).max(3),
  /** a sentiment choice below this confidence is reported as "uncertain" */
  minConfidence: z.number().min(0).max(1),
  /** the naive baseline: negative sentiment alone is a violation */
  flagNegativeSentiment: z.boolean(),
});
export type V1Thresholds = z.infer<typeof V1ThresholdsSchema>;

/**
 * Thresholds for battery v2, the choice-only battery (sentiment, attack, target,
 * severity, spam). Severity is the expected level over the four severity options,
 * so the numbers are comparable with v1.
 */
export const V2ThresholdsSchema = z.object({
  /** P(attacks a person or group) at or above this is a violation; null disables */
  attackViolation: z.number().min(0).max(1).nullable(),
  /** P(attacks a person or group) at or above this is unsure */
  attackUnsure: z.number().min(0).max(1),
  severityViolation: z.number().min(0).max(3),
  severityUnsure: z.number().min(0).max(3),
  /** P(spam or scam) at or above this is a violation */
  spamViolation: z.number().min(0).max(1),
  /** P(spam or scam) at or above this is unsure */
  spamUnsure: z.number().min(0).max(1),
  /**
   * Rude-level negativity aimed at a public figure who is the subject of the post is
   * ordinary political or product comment, not a violation. Harassment and threats
   * are judged the same whoever the target is.
   */
  tolerateRudeTowardPublicFigure: z.boolean(),
  minConfidence: z.number().min(0).max(1),
});
export type V2Thresholds = z.infer<typeof V2ThresholdsSchema>;

export const PolicySchema = z.object({
  name: z.string().min(1),
  v1: V1ThresholdsSchema,
  v2: V2ThresholdsSchema,
});
export type Policy = z.infer<typeof PolicySchema>;
