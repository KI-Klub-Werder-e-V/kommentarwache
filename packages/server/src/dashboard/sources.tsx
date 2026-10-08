import type { FC } from 'hono/jsx';
import type { SourceWithModes } from '../connectors/modes.js';
import type { CommentDetail } from '../review/queries.js';
import { BASE, fmtDate } from './layout.js';

const MODES = ['off', 'dry_run', 'propose', 'auto'] as const;

export const SourcesPage: FC<{ sources: SourceWithModes[] }> = ({ sources }) => (
  <>
    <h1>Sources</h1>
    <p class="muted small">
      Each source chooses for itself how far the system may act: <b>off</b> never, <b>dry run</b>{' '}
      records what it would have done, <b>propose</b> queues the action for a moderator, <b>auto</b>{' '}
      acts. The hourly cap drops auto to propose when reached.
    </p>
    <table>
      <thead>
        <tr>
          <th>Source</th>
          <th>Kind</th>
          <th class="num">Comments</th>
          <th>Hide</th>
          <th>Delete</th>
          <th>Ban</th>
          <th>Cap / h</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {sources.map((s) => (
          <tr>
            <td>
              {s.name}
              {!s.enabled ? <span class="muted small"> (disabled)</span> : null}
            </td>
            <td>{s.kind}</td>
            <td class="num">{s.comments}</td>
            <form
              method="post"
              action={`${BASE}/sources/${s.id}/modes`}
              id={`modes-${s.id}`}
            ></form>
            {(['hide', 'delete', 'ban'] as const).map((type) => (
              <td>
                <select name={type} form={`modes-${s.id}`}>
                  {MODES.map((m) => (
                    <option value={m} selected={s.modes[type] === m}>
                      {m.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </td>
            ))}
            <td>
              <input
                type="text"
                name="max_per_hour"
                form={`modes-${s.id}`}
                value={s.maxPerHour ?? ''}
                size={4}
              />
            </td>
            <td>
              <button type="submit" form={`modes-${s.id}`}>
                Save
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </>
);

/** Actions on one comment and the buttons a moderator has. */
export const ActionsSection: FC<{ d: CommentDetail }> = ({ d }) => {
  const c = d.comment;
  const hidden =
    d.actions
      .filter((a) => a.state === 'succeeded' && (a.type === 'hide' || a.type === 'unhide'))
      .at(-1)?.type === 'hide';
  const deleted = d.actions.some((a) => a.type === 'delete' && a.state === 'succeeded');
  const banned = d.actions.some((a) => a.type === 'ban' && a.state === 'succeeded' && !a.undoneAt);
  const proposals = d.actions.filter((a) => a.mode === 'proposed' && a.state === 'planned');
  return (
    <>
      <h2>Actions</h2>
      {d.actions.length === 0 ? <p class="muted small">No platform action yet.</p> : null}
      {d.actions.length > 0 ? (
        <table>
          <tbody>
            {d.actions.map((a) => (
              <tr>
                <td class="small muted">{fmtDate(a.executedAt ?? a.createdAt)}</td>
                <td>
                  <b>{a.type}</b>{' '}
                  <span class="muted small">
                    {a.mode} · {a.rule ?? ''}
                  </span>
                </td>
                <td>
                  {a.state}
                  {a.undoneAt ? <span class="muted small"> · undone</span> : null}
                  {a.overturnedAt ? <span class="muted small"> · overturned</span> : null}
                  {a.error ? <span class="error small"> {a.error}</span> : null}
                </td>
                <td class="small muted">
                  {a.actor} via {a.via}
                </td>
                <td>
                  {a.mode === 'proposed' && a.state === 'planned' ? (
                    <form method="post" action={`${BASE}/comments/${c.id}/action`} class="inline">
                      <button type="submit" name="op" value={`execute:${a.id}`} class="primary">
                        Execute {a.type}
                      </button>
                    </form>
                  ) : null}
                  {a.state === 'succeeded' &&
                  !a.undoneAt &&
                  (a.type === 'hide' || a.type === 'ban') ? (
                    <form method="post" action={`${BASE}/comments/${c.id}/action`} class="inline">
                      <button type="submit" name="op" value={`undo:${a.id}`}>
                        Undo {a.type}
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {proposals.length === 0 ? (
        <form method="post" action={`${BASE}/comments/${c.id}/action`} class="actions">
          {!hidden && !deleted ? (
            <button type="submit" name="op" value="hide">
              Hide
            </button>
          ) : null}
          {!deleted ? (
            <button type="submit" name="op" value="delete" class="violation">
              Delete
            </button>
          ) : null}
          {!banned && c.authorRef ? (
            <button type="submit" name="op" value="ban" class="violation">
              Ban author
            </button>
          ) : null}
        </form>
      ) : null}
    </>
  );
};
