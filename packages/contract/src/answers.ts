import { z } from 'zod';

/**
 * The System One answer shape. Stored raw with every assessment so a different policy
 * can be applied later without calling a model again.
 */
export const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

export const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  /** expected level, e.g. 1.47 on a 0 to 3 scale */
  score: z.number(),
  /** level index (as a string key) to level description */
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

export const NoulAnswerSchema = z.object({
  type: z.literal('noul'),
  /** probability that the statement is true, 0 to 1 */
  noul: z.number(),
});

export const AnswerSchema = z.discriminatedUnion('type', [
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
  NoulAnswerSchema,
]);
export type Answer = z.infer<typeof AnswerSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;
export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;

export const AnswersSchema = z.record(z.string(), AnswerSchema);
export type Answers = z.infer<typeof AnswersSchema>;

/** Token usage as reported by the provider; output tokens are free on Jev and zero on Laya. */
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;
