import type { Kysely } from 'kysely';
import { appendAudit } from '../audit.js';
import type { DB } from '../db/types.js';
import { hashPassword } from './password.js';

export async function createModerator(
  db: Kysely<DB>,
  opts: { email: string; name: string; password: string; scopes?: string[]; createdBy?: number },
): Promise<number> {
  const email = opts.email.trim().toLowerCase();
  const row = await db
    .insertInto('actors')
    .values({
      type: 'moderator',
      name: opts.name,
      email,
      password_hash: await hashPassword(opts.password),
      scopes: opts.scopes ?? ['moderate', 'review'],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(db, {
    actorId: opts.createdBy ?? null,
    via: 'cli',
    event: 'moderator.created',
    subjectType: 'actor',
    subjectId: row.id,
    payload: { email, name: opts.name },
  });
  return row.id;
}
