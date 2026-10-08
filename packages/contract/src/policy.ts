import { z } from 'zod';
import { CategorySchema, VerdictSchema } from './verdict.js';

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

/** One worked example the stage-2 text LLM sees alongside the policy text. */
export const Stage2ExampleSchema = z.object({
  text: z.string().min(1),
  verdict: VerdictSchema,
  category: CategorySchema,
  why: z.string().min(1),
});
export type Stage2Example = z.infer<typeof Stage2ExampleSchema>;

/**
 * Stage 2: a general text LLM reads the policy, a few examples and the thread context,
 * and gives an independent verdict for comments stage 1 found unsure. Its verdict is
 * accepted only above a confidence line; below it, the comment stays unsure and goes
 * to a human.
 */
export const Stage2PolicySchema = z.object({
  /** the community policy as the LLM reads it */
  policyText: z.string().min(1),
  examples: z.array(Stage2ExampleSchema),
  /** P(violation) at or above this accepts a violation verdict */
  violationConfidence: z.number().min(0).max(1),
  /** P(ok) at or above this accepts an ok verdict */
  okConfidence: z.number().min(0).max(1),
  /** a comment must leave stage 2 within this many seconds or it goes to a human */
  deadlineSeconds: z.number().int().positive(),
});
export type Stage2Policy = z.infer<typeof Stage2PolicySchema>;

/**
 * The action ladder. Hide needs stage 1 alone (reversible); delete and ban need both
 * stages to agree and a category on the list, or enough confirmed strikes.
 */
export const ActionsPolicySchema = z.object({
  /** categories that, confirmed by both stages, are deleted and not only hidden */
  deleteCategories: z.array(CategorySchema),
  /** categories that, confirmed by both stages, ban the author on the first comment */
  banCategories: z.array(CategorySchema),
  /** confirmed violations by one author within the window that ban the author */
  strikesForBan: z.number().int().positive(),
  strikeWindowDays: z.number().int().positive(),
});
export type ActionsPolicy = z.infer<typeof ActionsPolicySchema>;

/**
 * Thresholds for guard-style providers that give one probability of "unsafe" (Llama
 * Guard) or per-category scores (OpenAI moderation). They run as parallel or shadow
 * members; the verdict comes from the highest relevant score.
 */
export const ScoreThresholdsSchema = z.object({
  violation: z.number().min(0).max(1),
  unsure: z.number().min(0).max(1),
});
export type ScoreThresholds = z.infer<typeof ScoreThresholdsSchema>;

/** Which routing function turns a provider's answers into a verdict. */
export const MapperNameSchema = z.enum(['v1', 'v2', 'guard', 'openai']);
export type MapperName = z.infer<typeof MapperNameSchema>;

export const PolicySchema = z.object({
  name: z.string().min(1),
  v1: V1ThresholdsSchema,
  v2: V2ThresholdsSchema,
  guard: ScoreThresholdsSchema,
  openai: ScoreThresholdsSchema,
  stage2: Stage2PolicySchema,
  actions: ActionsPolicySchema,
});
export type Policy = z.infer<typeof PolicySchema>;
