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

export const PolicySchema = z.object({
  name: z.string().min(1),
  v1: V1ThresholdsSchema,
});
export type Policy = z.infer<typeof PolicySchema>;
