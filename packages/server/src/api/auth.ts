/**
 * API tokens for machines: agents, connectors on other hosts, the MCP shim. A token is
 * shown once at creation; only its hash is stored, on an actor row of type `agent`.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Context, Next } from 'hono';
import type { ActorType, DB } from '../db/types.js';

export interface AuthedActor {
  id: number;
  type: ActorType;
  name: string;
  scopes: string[];
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createApiToken(
  db: Kysely<DB>,
  opts: { name: string; scopes: string[]; ownerActorId?: number },
): Promise<{ actorId: number; token: string }> {
  const token = `kw_${randomBytes(24).toString('base64url')}`;
  const row = await db
    .insertInto('actors')
    .values({
      type: 'agent',
      name: opts.name,
      token_hash: hashToken(token),
      scopes: opts.scopes,
      owner_actor_id: opts.ownerActorId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { actorId: row.id, token };
}

export async function actorForToken(db: Kysely<DB>, token: string): Promise<AuthedActor | null> {
  const row = await db
    .selectFrom('actors')
    .select(['id', 'type', 'name', 'scopes'])
    .where('token_hash', '=', hashToken(token))
    .where('disabled_at', 'is', null)
    .executeTakeFirst();
  return row ?? null;
}

export type AuthEnv = { Variables: { actor: AuthedActor } };

export function hasScope(actor: { scopes: string[] }, scope: string): boolean {
  return actor.scopes.includes(scope) || actor.scopes.includes('*');
}

/** Hono middleware: requires `Authorization: Bearer <token>`, and the given scope if any. */
export function bearerAuth(db: Kysely<DB>, scope?: string) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return c.json({ error: 'missing bearer token' }, 401);
    const actor = await actorForToken(db, token);
    if (!actor) return c.json({ error: 'invalid token' }, 401);
    if (scope && !hasScope(actor, scope)) {
      return c.json({ error: `token lacks scope ${scope}` }, 403);
    }
    c.set('actor', actor);
    await next();
  };
}
