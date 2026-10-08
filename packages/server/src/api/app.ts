/**
 * The HTTP API. Every route is defined with a Zod schema so the OpenAPI document at
 * /openapi.json is always what the server does.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Kysely } from 'kysely';
import {
  ErrorResponseSchema,
  ModerateRequestSchema,
  ModerateResponseSchema,
} from '@kommentarwache/contract';
import { BASE } from '../dashboard/layout.js';
import { dashboardRoutes } from '../dashboard/routes.js';
import type { DB } from '../db/types.js';
import { contentHash, ingestComment } from '../pipeline/ingest.js';
import { ProviderFailed, runStage1 } from '../pipeline/stage1.js';
import type { ActivePipeline } from '../providers/registry.js';
import { bearerAuth, type AuthEnv } from './auth.js';

export interface AppDeps {
  db: Kysely<DB>;
  /** the active pipeline; cached by the caller, reloaded when `kw setup` changes it */
  pipeline: () => Promise<ActivePipeline>;
  log?: { error: (obj: object, msg: string) => void };
}

const moderateRoute = createRoute({
  method: 'post',
  path: '/v1/moderate',
  summary: 'Moderate one comment',
  description:
    'Stores the comment under its source and returns the stage-1 verdict. Idempotent on (source, id). ' +
    'Author fields are stored for the dashboard and never sent to a model.',
  request: {
    body: { content: { 'application/json': { schema: ModerateRequestSchema } }, required: true },
  },
  responses: {
    200: {
      description: 'stage-1 verdict',
      content: { 'application/json': { schema: ModerateResponseSchema } },
    },
    401: {
      description: 'missing or invalid token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: 'decision provider unavailable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  summary: 'Liveness',
  responses: {
    200: {
      description: 'ok',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
  },
});

export function createApp(deps: AppDeps) {
  // strict: false so /app and /app/ are the same page
  const app = new OpenAPIHono<AuthEnv>({ strict: false });

  app.onError((err, c) => {
    deps.log?.error({ err, path: c.req.path }, 'unhandled error');
    const detail = process.env['NODE_ENV'] === 'production' ? undefined : err.message;
    return c.json({ error: 'internal error', ...(detail ? { detail } : {}) }, 500);
  });

  app.openapi(healthRoute, (c) => c.json({ ok: true as const }, 200));

  app.use('/v1/*', bearerAuth(deps.db, 'moderate'));

  app.openapi(moderateRoute, async (c) => {
    const body = c.req.valid('json');
    const pipeline = await deps.pipeline();
    const connectorId = await ensureApiConnector(deps.db, body.source);
    const ingest = await ingestComment(deps.db, {
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

    try {
      const result = await runStage1(deps.db, pipeline, ingest.commentId);
      const comment = await deps.db
        .selectFrom('comments')
        .select('state')
        .where('id', '=', ingest.commentId)
        .executeTakeFirstOrThrow();
      const assessment = await deps.db
        .selectFrom('assessments')
        .select('model_version')
        .where('id', '=', result.assessmentId)
        .executeTakeFirst();
      return c.json(
        {
          comment_id: result.commentId,
          revision: result.revision,
          created: ingest.created,
          stage: 's1' as const,
          verdict: result.routing.verdict,
          category: result.routing.category,
          reasons: result.routing.reasons,
          state: comment.state,
          model: assessment?.model_version ?? null,
          policy: pipeline.policy.name,
        },
        200,
      );
    } catch (err) {
      if (err instanceof ProviderFailed) {
        return c.json({ error: 'decision provider unavailable', detail: err.message }, 503);
      }
      throw err;
    }
  });

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'kommentarwache', version: '0.1.0' },
  });

  // The moderator dashboard, under its own prefix so pages and API never share a path.
  app.route(BASE, dashboardRoutes(deps.db));
  app.get('/', (c) => c.redirect(`${BASE}/`));

  return app;
}

/** Comments posted to the API land in a connector of kind `api`, one per source name. */
async function ensureApiConnector(db: Kysely<DB>, name: string): Promise<number> {
  const found = await db
    .selectFrom('connectors')
    .select(['id', 'kind'])
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
