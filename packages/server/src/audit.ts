/**
 * The audit log: who did what, when, through which channel. Insert-only and
 * hash-chained, so a deleted or edited row is detectable with `kw audit verify`.
 */

import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from './db/types.js';

export interface AuditEntry {
  actorId: number | null;
  via: 'pipeline' | 'dashboard' | 'api' | 'mcp' | 'cli';
  event: string;
  subjectType?: string;
  subjectId?: number;
  payload?: Record<string, unknown>;
}

/** JSON with sorted keys at every level: jsonb does not keep key order, the hash must. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(prev: string | null, entry: AuditEntry, at: string): string {
  const body = canonicalJson([
    prev,
    at,
    entry.actorId,
    entry.via,
    entry.event,
    entry.subjectType ?? null,
    entry.subjectId ?? null,
    entry.payload ?? {},
  ]);
  return createHash('sha256').update(body).digest('hex');
}

/** Appends under a lock so the chain stays linear even with several writers. */
export async function appendAudit(db: Kysely<DB>, entry: AuditEntry): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(727002)`.execute(trx);
    const last = await trx
      .selectFrom('audit_log')
      .select('hash')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const at = new Date().toISOString();
    const row = await trx
      .insertInto('audit_log')
      .values({
        at,
        actor_id: entry.actorId,
        via: entry.via,
        event: entry.event,
        subject_type: entry.subjectType ?? null,
        subject_id: entry.subjectId ?? null,
        payload: JSON.stringify(entry.payload ?? {}),
        prev_hash: last?.hash ?? null,
        hash: digest(last?.hash ?? null, entry, at),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** Walks the whole chain; returns the first broken row id, or null when intact. */
export async function verifyAudit(
  db: Kysely<DB>,
): Promise<{ rows: number; brokenAt: number | null }> {
  const rows = await db.selectFrom('audit_log').selectAll().orderBy('id').execute();
  let prev: string | null = null;
  for (const r of rows) {
    const expected = digest(
      prev,
      {
        actorId: r.actor_id,
        via: r.via as AuditEntry['via'],
        event: r.event,
        ...(r.subject_type ? { subjectType: r.subject_type } : {}),
        ...(r.subject_id !== null ? { subjectId: r.subject_id } : {}),
        payload: r.payload,
      },
      r.at.toISOString(),
    );
    if (r.prev_hash !== prev || r.hash !== expected) return { rows: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { rows: rows.length, brokenAt: null };
}
