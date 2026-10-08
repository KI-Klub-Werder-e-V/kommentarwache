/**
 * Moderator sessions: a random id in an HttpOnly cookie, its hash in the sessions
 * table. Logging out deletes the row, so a stolen cookie dies with it.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DB } from '../db/types.js';
import { verifyPassword } from './password.js';

export const SESSION_COOKIE = 'kw_session';
const SESSION_DAYS = 14;

export interface Moderator {
  id: number;
  name: string;
  email: string;
  scopes: string[];
}

export type SessionEnv = { Variables: { moderator: Moderator } };

function hashSessionId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

export async function login(
  db: Kysely<DB>,
  email: string,
  password: string,
): Promise<{ moderator: Moderator; sessionId: string } | null> {
  const row = await db
    .selectFrom('actors')
    .select(['id', 'name', 'email', 'password_hash', 'scopes'])
    .where('type', '=', 'moderator')
    .where('email', '=', email.trim().toLowerCase())
    .where('disabled_at', 'is', null)
    .executeTakeFirst();
  // Verify against a dummy hash when the account is unknown, so timing does not reveal it.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) return null;

  const sessionId = randomBytes(32).toString('base64url');
  await db
    .insertInto('sessions')
    .values({
      id_hash: hashSessionId(sessionId),
      actor_id: row.id,
      expires_at: new Date(Date.now() + SESSION_DAYS * 86_400_000),
    })
    .execute();
  return {
    moderator: { id: row.id, name: row.name, email: row.email!, scopes: row.scopes },
    sessionId,
  };
}

export async function logout(db: Kysely<DB>, sessionId: string): Promise<void> {
  await db.deleteFrom('sessions').where('id_hash', '=', hashSessionId(sessionId)).execute();
}

export async function moderatorForSession(
  db: Kysely<DB>,
  sessionId: string,
): Promise<Moderator | null> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('actors', 'actors.id', 'sessions.actor_id')
    .select(['actors.id', 'actors.name', 'actors.email', 'actors.scopes'])
    .where('sessions.id_hash', '=', hashSessionId(sessionId))
    .where('sessions.expires_at', '>', new Date())
    .where('actors.disabled_at', 'is', null)
    .executeTakeFirst();
  return row ? { id: row.id, name: row.name, email: row.email!, scopes: row.scopes } : null;
}

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: c.req.url.startsWith('https://'),
    maxAge: SESSION_DAYS * 86_400,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Hono middleware: a signed-in moderator or a redirect to the login page. */
export function requireModerator(db: Kysely<DB>) {
  return async (c: Context<SessionEnv>, next: Next) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    const moderator = sessionId ? await moderatorForSession(db, sessionId) : null;
    if (!moderator) {
      if (c.req.method !== 'GET') return c.text('sign in first', 401);
      return c.redirect(`/app/login?next=${encodeURIComponent(c.req.path)}`);
    }
    c.set('moderator', moderator);
    await next();
  };
}

/**
 * Forms and htmx requests must come from this site. Cookies are SameSite=Lax, and
 * cross-site POSTs are refused outright by checking the fetch metadata browsers send.
 */
export async function sameOriginOnly(c: Context, next: Next) {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none')
      return c.text('cross-site request refused', 403);
  }
  await next();
}

const DUMMY_HASH =
  'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
