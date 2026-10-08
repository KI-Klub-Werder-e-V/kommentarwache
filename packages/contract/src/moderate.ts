import { z } from 'zod';
import { CategorySchema, VerdictSchema } from './verdict.js';

/** What a model may see besides the comment text. Never author names or IDs. */
export const CommentContextSchema = z.object({
  platform: z.string().optional(),
  post: z.string().optional(),
  parent_comment: z.string().optional(),
  comment_kind: z.string().optional(),
});
export type CommentContext = z.infer<typeof CommentContextSchema>;

/** POST /v1/moderate: one comment in, a stage-1 verdict out. */
export const ModerateRequestSchema = z.object({
  /** which connector (source) this comment belongs to; created on first use for the API kind */
  source: z.string().min(1).max(100).default('api'),
  /** the platform's id for the comment; omitted means the text's hash */
  id: z.string().min(1).max(500).optional(),
  text: z.string().min(1).max(20_000),
  context: CommentContextSchema.optional(),
  author_ref: z.string().max(500).optional(),
  author_name: z.string().max(500).optional(),
  permalink: z.string().url().optional(),
  parent_id: z.string().max(500).optional(),
  thread_ref: z.string().max(500).optional(),
  created_at: z.string().datetime().optional(),
});
export type ModerateRequest = z.infer<typeof ModerateRequestSchema>;

export const ModerateResponseSchema = z.object({
  comment_id: z.number().int(),
  revision: z.number().int(),
  /** false when this delivery was a duplicate of a comment already known */
  created: z.boolean(),
  stage: z.literal('s1'),
  verdict: VerdictSchema,
  category: CategorySchema.or(z.string()),
  reasons: z.array(z.string()),
  /** closed: final; s2_pending / human_pending: a later stage will decide */
  state: z.enum(['s1_pending', 's2_pending', 'human_pending', 'closed']),
  model: z.string().nullable(),
  policy: z.string(),
});
export type ModerateResponse = z.infer<typeof ModerateResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
