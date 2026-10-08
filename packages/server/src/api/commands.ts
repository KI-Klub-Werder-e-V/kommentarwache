/**
 * REST routes generated from the command catalogue. Path params, query and JSON body
 * are merged into one input object and validated by the command's schema.
 */

import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { COMMANDS, COMMAND_NAMES, type CommandName } from '@kommentarwache/contract';
import { CommandError, runCommand } from '../commands/run.js';
import type { DB } from '../db/types.js';
import type { ActivePipeline } from '../providers/registry.js';
import { bearerAuth, type AuthEnv } from './auth.js';

/** Query strings are text; numbers and booleans in them are coerced before validation. */
function coerce(value: string): unknown {
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value;
}

export function commandRoutes(
  db: Kysely<DB>,
  pipeline: () => Promise<ActivePipeline>,
  skip: CommandName[] = [],
) {
  const app = new Hono<AuthEnv>({ strict: false });
  const auth = bearerAuth(db);

  for (const name of COMMAND_NAMES) {
    if (skip.includes(name)) continue;
    const spec = COMMANDS[name];
    // auth per route, not `use('*')`: a sub-app's wildcard middleware would also run for
    // the parent's other paths
    app.on(spec.method, spec.path, auth, async (c) => {
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c.req.query())) input[k] = coerce(v);
      if (spec.method !== 'GET') {
        const body = await c.req.json().catch(() => ({}));
        if (body && typeof body === 'object') Object.assign(input, body);
      }
      for (const [k, v] of Object.entries(c.req.param())) input[k] = coerce(v);
      try {
        const result = await runCommand(
          name,
          { db, pipeline, actor: c.get('actor'), via: 'api' },
          input,
        );
        return c.json(result as object, 200);
      } catch (err) {
        if (err instanceof CommandError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    });
  }
  return app;
}
