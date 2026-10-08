/** The moderate command: ingest one comment and run stage 1, the same for REST and MCP. */

import type { Kysely } from 'kysely';
import type { ModerateRequest, ModerateResponse } from '@kommentarwache/contract';
import type { DB } from '../db/types.js';
import { contentHash, ingestComment } from '../pipeline/ingest.js';
import { runStage1 } from '../pipeline/stage1.js';
import type { ActivePipeline } from '../providers/registry.js';

export async function moderateComment(
  db: Kysely<DB>,
  pipeline: ActivePipeline,
  body: ModerateRequest,
): Promise<ModerateResponse> {
  const connectorId = await ensureApiConnector(db, body.source);
  const ingest = await ingestComment(db, {
    connectorId,
    platformCommentId: body.id ?? contentHash(body.text),
    text: body.text,
    ...(body.context ? { context: body.context } : {}),
    ...(body.author_ref ? { authorRef: body.author_ref } : {}),
    ...(body.author_name ? { authorName: body.author_name } : {}),
    ...(body.permalink ? { permalink: body.permalink } : {}),
    ...(body.parent_id ? { parentPlatformId: body.parent_id } : {}),
    ...(body.thread_ref ? { threadRef: body.thread_ref } : {}),
    ...(body.created_at ? { platformCreatedAt: new Date(body.created_at) } : {}),
  });
  const result = await runStage1(db, pipeline, ingest.commentId);
  const comment = await db
    .selectFrom('comments')
    .select('state')
    .where('id', '=', ingest.commentId)
    .executeTakeFirstOrThrow();
  const assessment = await db
    .selectFrom('assessments')
    .select('model_version')
    .where('id', '=', result.assessmentId)
    .executeTakeFirst();
  return {
    comment_id: result.commentId,
    revision: result.revision,
    created: ingest.created,
    stage: 's1',
    verdict: result.routing.verdict,
    category: result.routing.category,
    reasons: result.routing.reasons,
    state: comment.state,
    model: assessment?.model_version ?? null,
    policy: pipeline.policy.name,
  };
}

/** Comments posted to the API land in a connector of kind `api`, one per source name. */
export async function ensureApiConnector(db: Kysely<DB>, name: string): Promise<number> {
  const found = await db
    .selectFrom('connectors')
    .select('id')
    .where('name', '=', name)
    .executeTakeFirst();
  if (found) return found.id;
  const row = await db
    .insertInto('connectors')
    .values({ kind: 'api', name })
    .onConflict((oc) => oc.column('name').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (row) return row.id;
  return (
    await db
      .selectFrom('connectors')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirstOrThrow()
  ).id;
}
