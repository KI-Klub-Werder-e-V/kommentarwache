/** Reads for the dashboard: the queue, one comment's timeline, and the decision log. */

import type { Kysely } from 'kysely';
import type { Verdict } from '@kommentarwache/contract';
import type { DB } from '../db/types.js';

export interface QueueItem {
  reviewId: number;
  commentId: number;
  reason: string;
  priority: number;
  queuedAt: Date;
  source: string;
  platformCommentId: string;
  text: string;
  permalink: string | null;
  authorName: string | null;
  s1Verdict: Verdict | null;
  s1Category: string | null;
  s2Verdict: Verdict | null;
  s2Category: string | null;
  s2Rationale: string | null;
}

export async function listQueue(db: Kysely<DB>, limit = 100): Promise<QueueItem[]> {
  const rows = await db
    .selectFrom('review_items as r')
    .innerJoin('comments as c', 'c.id', 'r.comment_id')
    .innerJoin('connectors as k', 'k.id', 'c.connector_id')
    .leftJoin('authors as a', 'a.id', 'c.author_id')
    .leftJoin('comment_outcomes as o', 'o.comment_id', 'c.id')
    .select([
      'r.id as reviewId',
      'r.comment_id as commentId',
      'r.reason',
      'r.priority',
      'r.created_at as queuedAt',
      'k.name as source',
      'c.platform_comment_id as platformCommentId',
      'c.text',
      'c.permalink',
      'a.display_name as authorName',
      'o.s1_verdict as s1Verdict',
      'o.s1_category as s1Category',
      'o.s2_verdict as s2Verdict',
      'o.s2_category as s2Category',
    ])
    .where('r.resolved_at', 'is', null)
    .orderBy('r.priority', 'desc')
    .orderBy('r.created_at', 'asc')
    .limit(limit)
    .execute();
  const rationales = await stage2Rationales(
    db,
    rows.map((r) => r.commentId),
  );
  return rows.map((r) => ({ ...r, s2Rationale: rationales.get(r.commentId) ?? null }));
}

async function stage2Rationales(
  db: Kysely<DB>,
  commentIds: number[],
): Promise<Map<number, string>> {
  if (commentIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('assessments')
    .select(['comment_id', 'raw'])
    .where('comment_id', 'in', commentIds)
    .where('stage', '=', 's2')
    .where('status', '=', 'ok')
    .execute();
  const out = new Map<number, string>();
  for (const r of rows) {
    const rationale = (r.raw as { rationale?: unknown } | null)?.rationale;
    if (typeof rationale === 'string' && rationale) out.set(r.comment_id, rationale);
  }
  return out;
}

export interface CommentDetail {
  comment: {
    id: number;
    source: string;
    platformCommentId: string;
    text: string;
    permalink: string | null;
    context: Record<string, unknown>;
    authorName: string | null;
    authorRef: string | null;
    revision: number;
    state: string;
    finalVerdict: Verdict | null;
    finalCategory: string | null;
    finalStage: string | null;
    ingestedAt: Date;
    platformCreatedAt: Date | null;
  };
  assessments: Array<{
    id: number;
    stage: string;
    role: string;
    status: string;
    provider: string;
    model: string | null;
    latencyMs: number | null;
    answers: Record<string, unknown> | null;
    rationale: string | null;
    error: string | null;
    createdAt: Date;
  }>;
  decisions: Array<{
    id: number;
    stage: string;
    verdict: Verdict;
    category: string;
    reasons: string[];
    actor: string;
    via: string;
    note: string | null;
    createdAt: Date;
  }>;
  reviewItems: Array<{ id: number; reason: string; createdAt: Date; resolvedAt: Date | null }>;
  labels: Array<{ source: string; verdict: Verdict; note: string | null }>;
  actions: Array<{
    id: number;
    type: string;
    mode: string;
    state: string;
    rule: string | null;
    actor: string;
    via: string;
    error: string | null;
    createdAt: Date;
    executedAt: Date | null;
    undoneAt: Date | null;
    overturnedAt: Date | null;
  }>;
}

export async function commentDetail(db: Kysely<DB>, id: number): Promise<CommentDetail | null> {
  const c = await db
    .selectFrom('comments')
    .innerJoin('connectors', 'connectors.id', 'comments.connector_id')
    .leftJoin('authors', 'authors.id', 'comments.author_id')
    .select([
      'comments.id',
      'connectors.name as source',
      'comments.platform_comment_id',
      'comments.text',
      'comments.permalink',
      'comments.context',
      'authors.display_name',
      'authors.platform_author_id',
      'comments.revision',
      'comments.state',
      'comments.final_verdict',
      'comments.final_category',
      'comments.final_stage',
      'comments.ingested_at',
      'comments.platform_created_at',
    ])
    .where('comments.id', '=', id)
    .executeTakeFirst();
  if (!c) return null;

  const assessments = await db
    .selectFrom('assessments')
    .innerJoin('provider_configs', 'provider_configs.id', 'assessments.provider_config_id')
    .select([
      'assessments.id',
      'assessments.stage',
      'assessments.role',
      'assessments.status',
      'provider_configs.name as provider',
      'assessments.model_version',
      'assessments.latency_ms',
      'assessments.answers',
      'assessments.raw',
      'assessments.error',
      'assessments.created_at',
    ])
    .where('assessments.comment_id', '=', id)
    .orderBy('assessments.id')
    .execute();
  const decisions = await db
    .selectFrom('decisions')
    .innerJoin('actors', 'actors.id', 'decisions.actor_id')
    .select([
      'decisions.id',
      'decisions.stage',
      'decisions.verdict',
      'decisions.category',
      'decisions.reasons',
      'actors.name as actor',
      'decisions.via',
      'decisions.note',
      'decisions.created_at',
    ])
    .where('decisions.comment_id', '=', id)
    .where('decisions.effective', '=', true)
    .orderBy('decisions.id')
    .execute();
  const reviewItems = await db
    .selectFrom('review_items')
    .select(['id', 'reason', 'created_at', 'resolved_at'])
    .where('comment_id', '=', id)
    .orderBy('id')
    .execute();
  const labels = await db
    .selectFrom('labels')
    .select(['source', 'verdict', 'note'])
    .where('comment_id', '=', id)
    .execute();
  const actions = await db
    .selectFrom('actions')
    .innerJoin('actors', 'actors.id', 'actions.actor_id')
    .select([
      'actions.id',
      'actions.action_type as type',
      'actions.mode',
      'actions.state',
      'actions.rule',
      'actors.name as actor',
      'actions.via',
      'actions.error',
      'actions.created_at as createdAt',
      'actions.executed_at as executedAt',
      'actions.undone_at as undoneAt',
      'actions.overturned_at as overturnedAt',
    ])
    .where('actions.comment_id', '=', id)
    .orderBy('actions.id')
    .execute();

  return {
    comment: {
      id: c.id,
      source: c.source,
      platformCommentId: c.platform_comment_id,
      text: c.text,
      permalink: c.permalink,
      context: c.context,
      authorName: c.display_name,
      authorRef: c.platform_author_id,
      revision: c.revision,
      state: c.state,
      finalVerdict: c.final_verdict,
      finalCategory: c.final_category,
      finalStage: c.final_stage,
      ingestedAt: c.ingested_at,
      platformCreatedAt: c.platform_created_at,
    },
    assessments: assessments.map((a) => ({
      id: a.id,
      stage: a.stage,
      role: a.role,
      status: a.status,
      provider: a.provider,
      model: a.model_version,
      latencyMs: a.latency_ms,
      answers: a.answers,
      rationale:
        typeof (a.raw as { rationale?: unknown } | null)?.rationale === 'string'
          ? (a.raw as { rationale: string }).rationale
          : null,
      error: a.error,
      createdAt: a.created_at,
    })),
    decisions: decisions.map((d) => ({
      id: d.id,
      stage: d.stage,
      verdict: d.verdict,
      category: d.category,
      reasons: d.reasons,
      actor: d.actor,
      via: d.via,
      note: d.note,
      createdAt: d.created_at,
    })),
    reviewItems: reviewItems.map((r) => ({
      id: r.id,
      reason: r.reason,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    })),
    labels,
    actions,
  };
}

export interface LogFilters {
  stage?: string | undefined;
  verdict?: string | undefined;
  source?: string | undefined;
  limit?: number;
}

export interface LogRow {
  decisionId: number;
  createdAt: Date;
  commentId: number;
  source: string;
  stage: string;
  verdict: Verdict;
  category: string;
  actor: string;
  via: string;
  text: string;
  reasons: string[];
}

export async function listLog(db: Kysely<DB>, f: LogFilters = {}): Promise<LogRow[]> {
  let q = db
    .selectFrom('decisions as d')
    .innerJoin('comments as c', 'c.id', 'd.comment_id')
    .innerJoin('connectors as k', 'k.id', 'c.connector_id')
    .innerJoin('actors as a', 'a.id', 'd.actor_id')
    .select([
      'd.id as decisionId',
      'd.created_at as createdAt',
      'c.id as commentId',
      'k.name as source',
      'd.stage',
      'd.verdict',
      'd.category',
      'a.name as actor',
      'd.via',
      'c.text',
      'd.reasons',
    ])
    .where('d.effective', '=', true)
    .orderBy('d.id', 'desc')
    .limit(f.limit ?? 100);
  if (f.stage) q = q.where('d.stage', '=', f.stage as 's1' | 's2' | 'human');
  if (f.verdict) q = q.where('d.verdict', '=', f.verdict as Verdict);
  if (f.source) q = q.where('k.name', '=', f.source);
  return q.execute();
}

export async function listSources(db: Kysely<DB>): Promise<string[]> {
  const rows = await db.selectFrom('connectors').select('name').orderBy('name').execute();
  return rows.map((r) => r.name);
}
