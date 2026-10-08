import { z } from 'zod';

/**
 * The System One request shape shared by Jev (api.typesafe.ai) and Laya (laya-serve):
 * a `state` plus a map of typed questions. A battery is such a map with a version.
 */
export const ChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string().min(1),
  /** option key to description; a null description means the key speaks for itself */
  criteria: z.record(z.string(), z.string().nullable()),
});

export const ScoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: z.string().min(1),
  /** ordered level descriptions, lowest first; 2 to 10 levels */
  criteria: z.array(z.string().min(1)).min(2).max(10),
});

export const NoulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: z.string().min(1),
  criteria: z.object({ true: z.string(), false: z.string() }).optional(),
});

export const QuestionSchema = z.discriminatedUnion('type', [
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  NoulQuestionSchema,
]);
export type Question = z.infer<typeof QuestionSchema>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type NoulQuestion = z.infer<typeof NoulQuestionSchema>;

export const QuestionsSchema = z.record(z.string(), QuestionSchema);
export type Questions = z.infer<typeof QuestionsSchema>;

export const BatterySchema = z.object({
  /** stable name, e.g. "v1-prototype" or "v2-choice" */
  name: z.string().min(1),
  version: z.number().int().positive(),
  questions: QuestionsSchema,
});
export type Battery = z.infer<typeof BatterySchema>;
