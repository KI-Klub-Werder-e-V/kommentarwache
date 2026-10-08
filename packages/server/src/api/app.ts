/**
 * The HTTP surface: the OpenAPI-documented moderate route, the REST routes generated
 * from the command catalogue, the MCP endpoint, and the dashboard. One token model for
 * all of it.
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
import { handleMcpRequest } from '../mcp/server.js';
import { ProviderFailed } from '../pipeline/stage1.js';
import type { ActivePipeline } from '../providers/registry.js';
import { bearerAuth, type AuthEnv } from './auth.js';
import { commandRoutes } from './commands.js';
import { moderateComment } from './moderate.js';

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

  app.use('/v1/moderate', bearerAuth(deps.db, 'moderate'));
  app.openapi(moderateRoute, async (c) => {
    try {
      const result = await moderateComment(deps.db, await deps.pipeline(), c.req.valid('json'));
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof ProviderFailed) {
        return c.json({ error: 'decision provider unavailable', detail: err.message }, 503);
      }
      throw err;
    }
  });

  // Every other command, with the same scopes the MCP tools use.
  app.route('/', commandRoutes(deps.db, deps.pipeline, ['moderate_comment']));

  // MCP over streamable HTTP, stateless, under the same bearer tokens.
  app.use('/mcp', bearerAuth(deps.db));
  app.all('/mcp', (c) =>
    handleMcpRequest({ db: deps.db, pipeline: deps.pipeline, actor: c.get('actor') }, c.req.raw),
  );

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'kommentarwache', version: '0.1.0' },
  });

  // The moderator dashboard, under its own prefix so pages and API never share a path.
  app.route(BASE, dashboardRoutes(deps.db, deps.pipeline));
  app.get('/', (c) => c.redirect(`${BASE}/`));

  return app;
}
