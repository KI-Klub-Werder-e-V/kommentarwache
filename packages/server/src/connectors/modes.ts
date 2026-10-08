/** Per-source modes for hide, delete and ban: off, dry_run, propose or auto, plus an hourly cap. */

import type { Kysely } from 'kysely';
import { appendAudit } from '../audit.js';
import type { ConnectorActionMode, DB } from '../db/types.js';

export interface SourceWithModes {
  id: number;
  kind: string;
  name: string;
  enabled: boolean;
  comments: number;
  modes: Record<'hide' | 'delete' | 'ban', ConnectorActionMode>;
  maxPerHour: number | null;
}

export async function listSourcesWithModes(db: Kysely<DB>): Promise<SourceWithModes[]> {
  const rows = await db
    .selectFrom('connectors')
    .leftJoin('comments', 'comments.connector_id', 'connectors.id')
    .select(['connectors.id', 'connectors.kind', 'connectors.name', 'connectors.enabled'])
    .select((eb) => eb.fn.count<number>('comments.id').as('comments'))
    .groupBy(['connectors.id', 'connectors.kind', 'connectors.name', 'connectors.enabled'])
    .orderBy('connectors.name')
    .execute();
  const modes = await db.selectFrom('connector_action_modes').selectAll().execute();
  return rows.map((r) => {
    const mine = modes.filter((m) => m.connector_id === r.id);
    const get = (t: 'hide' | 'delete' | 'ban') => mine.find((m) => m.action_type === t);
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      enabled: r.enabled,
      comments: Number(r.comments),
      modes: {
        hide: get('hide')?.mode ?? 'off',
        delete: get('delete')?.mode ?? 'off',
        ban: get('ban')?.mode ?? 'off',
      },
      maxPerHour: mine.find((m) => m.max_per_hour !== null)?.max_per_hour ?? null,
    };
  });
}

export async function setConnectorModes(
  db: Kysely<DB>,
  connectorId: number,
  modes: Record<'hide' | 'delete' | 'ban', ConnectorActionMode>,
  maxPerHour: number | null,
  actorId: number,
  via: 'dashboard' | 'cli' | 'api' | 'mcp',
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const [action_type, mode] of Object.entries(modes) as Array<
      ['hide' | 'delete' | 'ban', ConnectorActionMode]
    >) {
      await trx
        .insertInto('connector_action_modes')
        .values({ connector_id: connectorId, action_type, mode, max_per_hour: maxPerHour })
        .onConflict((oc) =>
          oc
            .columns(['connector_id', 'action_type'])
            .doUpdateSet({ mode, max_per_hour: maxPerHour }),
        )
        .execute();
    }
  });
  await appendAudit(db, {
    actorId,
    via,
    event: 'connector.modes',
    subjectType: 'connector',
    subjectId: connectorId,
    payload: { ...modes, maxPerHour },
  });
}
