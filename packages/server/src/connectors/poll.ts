/**
 * Polling: every few minutes, ask each enabled source that can poll for comments newer
 * than its cursor, store them, and queue stage 1. Webhooks are an optimisation on top
 * of this; polling is what works when the server has no public URL.
 */

import type { Kysely } from 'kysely';
import { appendAudit } from '../audit.js';
import type { DB } from '../db/types.js';
import { ingestComment } from '../pipeline/ingest.js';
import { enqueueStage1 } from '../pipeline/queue.js';
import type { ConnectorRegistry } from './connector.js';
import { decryptSecrets } from './secrets.js';

export interface PollDeps {
  connectors: ConnectorRegistry;
  secretKey: Buffer | undefined;
  /** stage 1 for polled comments runs in the worker; tests pass a stub */
  enqueue?: (db: Kysely<DB>, commentId: number) => Promise<void>;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface PollSummary {
  source: string;
  fetched: number;
  created: number;
  edited: number;
  error?: string;
}

export async function pollConnector(
  db: Kysely<DB>,
  deps: PollDeps,
  connectorId: number,
): Promise<PollSummary> {
  const row = await db
    .selectFrom('connectors')
    .selectAll()
    .where('id', '=', connectorId)
    .executeTakeFirstOrThrow();
  const summary: PollSummary = { source: row.name, fetched: 0, created: 0, edited: 0 };
  let connector;
  try {
    const secrets = deps.secretKey ? decryptSecrets(row.secrets_enc, deps.secretKey) : {};
    connector = deps.connectors.get({
      id: row.id,
      kind: row.kind,
      name: row.name,
      config: row.config,
      secrets,
    });
  } catch (err) {
    summary.error = `cannot build connector: ${(err as Error).message}`;
    return summary;
  }
  if (!connector?.poll) {
    summary.error = `${row.kind} cannot poll`;
    return summary;
  }

  try {
    const result = await connector.poll(row.cursor);
    summary.fetched = result.comments.length;
    for (const c of result.comments) {
      const r = await ingestComment(db, {
        connectorId: row.id,
        platformCommentId: c.platformCommentId,
        text: c.text,
        ...(c.context ? { context: c.context } : {}),
        ...(c.authorRef ? { authorRef: c.authorRef } : {}),
        ...(c.authorName ? { authorName: c.authorName } : {}),
        ...(c.permalink ? { permalink: c.permalink } : {}),
        ...(c.parentPlatformId ? { parentPlatformId: c.parentPlatformId } : {}),
        ...(c.threadRef ? { threadRef: c.threadRef } : {}),
        ...(c.platformCreatedAt ? { platformCreatedAt: c.platformCreatedAt } : {}),
      });
      if (r.created) summary.created++;
      if (r.edited) summary.edited++;
      if (r.created || r.edited) await (deps.enqueue ?? enqueueStage1)(db, r.commentId);
    }
    await db
      .updateTable('connectors')
      .set({ cursor: JSON.stringify(result.cursor) })
      .where('id', '=', row.id)
      .execute();
    deps.log?.info(summary, 'polled');
  } catch (err) {
    summary.error = (err as Error).message;
    deps.log?.warn(summary, 'poll failed');
    await appendAudit(db, {
      actorId: null,
      via: 'pipeline',
      event: 'poll.failed',
      subjectType: 'connector',
      subjectId: row.id,
      payload: { error: summary.error },
    });
  }
  return summary;
}

/** Poll every enabled source whose kind can poll. Failures are per source and logged. */
export async function pollAll(db: Kysely<DB>, deps: PollDeps): Promise<PollSummary[]> {
  const rows = await db
    .selectFrom('connectors')
    .select(['id', 'kind'])
    .where('enabled', '=', true)
    .where('kind', 'in', ['youtube', 'facebook', 'instagram'])
    .orderBy('id')
    .execute();
  const out: PollSummary[] = [];
  for (const r of rows) out.push(await pollConnector(db, deps, r.id));
  return out;
}
