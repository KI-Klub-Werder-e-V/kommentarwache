/**
 * Ingest one comment. Idempotent on (connector, platform comment id): a second delivery
 * of the same comment returns the existing row. An edited comment bumps the revision so
 * it is assessed again.
 */

import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { CommentContext, DB } from '../db/types.js';

export interface IngestInput {
  connectorId: number;
  platformCommentId: string;
  text: string;
  context?: CommentContext;
  /** the platform's id for the author; stored, never sent to a model */
  authorRef?: string;
  authorName?: string;
  permalink?: string;
  parentPlatformId?: string;
  threadRef?: string;
  platformCreatedAt?: Date;
  isBackfill?: boolean;
  lang?: string;
}

export interface IngestResult {
  commentId: number;
  revision: number;
  /** false when the comment was already known and unchanged */
  created: boolean;
  edited: boolean;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function ingestComment(db: Kysely<DB>, input: IngestInput): Promise<IngestResult> {
  return db.transaction().execute(async (trx) => {
    const authorId = input.authorRef
      ? await ensureAuthor(trx, input.connectorId, input.authorRef, input.authorName)
      : null;
    const hash = contentHash(input.text);

    const inserted = await trx
      .insertInto('comments')
      .values({
        connector_id: input.connectorId,
        platform_comment_id: input.platformCommentId,
        author_id: authorId,
        parent_platform_id: input.parentPlatformId ?? null,
        thread_ref: input.threadRef ?? null,
        permalink: input.permalink ?? null,
        text: input.text,
        content_hash: hash,
        lang: input.lang ?? null,
        context: JSON.stringify(input.context ?? {}),
        platform_created_at: input.platformCreatedAt ?? null,
        is_backfill: input.isBackfill ?? false,
        state: 's1_pending',
      })
      .onConflict((oc) => oc.columns(['connector_id', 'platform_comment_id']).doNothing())
      .returning(['id', 'revision'])
      .executeTakeFirst();
    if (inserted)
      return { commentId: inserted.id, revision: inserted.revision, created: true, edited: false };

    const existing = await trx
      .selectFrom('comments')
      .select(['id', 'revision', 'content_hash'])
      .where('connector_id', '=', input.connectorId)
      .where('platform_comment_id', '=', input.platformCommentId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (existing.content_hash === hash) {
      return { commentId: existing.id, revision: existing.revision, created: false, edited: false };
    }

    // The platform reports an edit: start over on the new text. Planned actions for the
    // old text must not run.
    const revision = existing.revision + 1;
    await trx
      .updateTable('comments')
      .set({
        text: input.text,
        content_hash: hash,
        revision,
        state: 's1_pending',
        state_deadline_at: null,
        final_verdict: null,
        final_category: null,
        final_stage: null,
        closed_at: null,
      })
      .where('id', '=', existing.id)
      .execute();
    await trx
      .updateTable('actions')
      .set({ state: 'cancelled', error: 'comment edited before execution' })
      .where('comment_id', '=', existing.id)
      .where('state', '=', 'planned')
      .execute();
    return { commentId: existing.id, revision, created: false, edited: true };
  });
}

async function ensureAuthor(
  db: Kysely<DB>,
  connectorId: number,
  platformAuthorId: string,
  displayName: string | undefined,
): Promise<number> {
  const row = await db
    .insertInto('authors')
    .values({
      connector_id: connectorId,
      platform_author_id: platformAuthorId,
      display_name: displayName ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['connector_id', 'platform_author_id']).doUpdateSet((eb) => ({
        display_name: eb.fn.coalesce(
          eb.ref('excluded.display_name'),
          eb.ref('authors.display_name'),
        ),
      })),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
