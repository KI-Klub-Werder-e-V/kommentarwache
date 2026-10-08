import type { FC } from 'hono/jsx';
import { CategorySchema } from '@kommentarwache/contract';
import type { DailyRow, Overview, ProviderStats } from '../analytics/queries.js';
import type { CommentDetail, LogRow, QueueItem } from '../review/queries.js';
import { BASE, fmtDate, truncate, VerdictBadge } from './layout.js';
import { ActionsSection } from './sources.js';

export const LoginPage: FC<{ error?: string | undefined; next?: string | undefined }> = ({
  error,
  next,
}) => (
  <div class="login">
    <h1>Sign in</h1>
    {error ? <p class="error">{error}</p> : null}
    <form method="post" action={`${BASE}/login`}>
      <input type="hidden" name="next" value={next ?? `${BASE}/`} />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="username" />
      <label for="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autocomplete="current-password"
      />
      <p>
        <button type="submit" class="primary">
          Sign in
        </button>
      </p>
    </form>
  </div>
);

export const QueuePage: FC<{ items: QueueItem[] }> = ({ items }) => (
  <>
    <h1>Review queue</h1>
    {items.length === 0 ? (
      <p class="muted">Nothing waiting. The models handled everything.</p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>Comment</th>
            <th>Source</th>
            <th>Why here</th>
            <th>Stage 1</th>
            <th>Stage 2</th>
            <th>Queued</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr>
              <td>
                <a href={`${BASE}/comments/${i.commentId}`}>{truncate(i.text)}</a>
                {i.permalink ? (
                  <>
                    {' '}
                    <a href={i.permalink} target="_blank" rel="noopener" class="small">
                      open on platform ↗
                    </a>
                  </>
                ) : null}
                {i.s2Rationale ? <div class="small muted">{i.s2Rationale}</div> : null}
              </td>
              <td>{i.source}</td>
              <td class="small">{i.reason.replace(/_/g, ' ')}</td>
              <td>
                <VerdictBadge verdict={i.s1Verdict} category={i.s1Category} />
              </td>
              <td>
                <VerdictBadge verdict={i.s2Verdict} category={i.s2Category} />
              </td>
              <td class="small muted">{fmtDate(i.queuedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </>
);

export const CommentPage: FC<{ d: CommentDetail; nextInQueue?: number | undefined }> = ({
  d,
  nextInQueue,
}) => {
  const c = d.comment;
  const open = d.reviewItems.some((r) => r.resolvedAt === null);
  return (
    <>
      <h1>
        Comment #{c.id} <span class="muted small">from {c.source}</span>
      </h1>
      <blockquote class="text">{c.text}</blockquote>
      <dl>
        <dt>Status</dt>
        <dd>
          {c.state}
          {c.finalVerdict ? (
            <>
              {' '}
              <VerdictBadge verdict={c.finalVerdict} category={c.finalCategory} />{' '}
              <span class="muted small">by {c.finalStage}</span>
            </>
          ) : null}
        </dd>
        <dt>Author</dt>
        <dd>{c.authorName ?? c.authorRef ?? <span class="muted">unknown</span>}</dd>
        <dt>Platform id</dt>
        <dd>
          {c.platformCommentId}
          {c.permalink ? (
            <>
              {' '}
              <a href={c.permalink} target="_blank" rel="noopener">
                open on platform ↗
              </a>
            </>
          ) : null}
        </dd>
        {Object.entries(c.context).map(([k, v]) => (
          <>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd class="text">{String(v)}</dd>
          </>
        ))}
        <dt>Ingested</dt>
        <dd>
          {fmtDate(c.ingestedAt)} <span class="muted small">revision {c.revision}</span>
        </dd>
      </dl>

      {open || c.state !== 'closed' ? (
        <>
          <h2>Your decision</h2>
          <form method="post" action={`${BASE}/comments/${c.id}/decide`}>
            <input type="hidden" name="next" value={nextInQueue ? String(nextInQueue) : ''} />
            <div class="actions">
              <button type="submit" name="verdict" value="ok" class="ok">
                OK, leave it
              </button>
              <button type="submit" name="verdict" value="violation" class="violation">
                Violation
              </button>
              <select name="category">
                {CategorySchema.options
                  .filter((o) => o !== 'none')
                  .map((o) => (
                    <option value={o} selected={o === 'harassment'}>
                      {o}
                    </option>
                  ))}
              </select>
              <input type="text" name="note" placeholder="note (optional)" size={40} />
            </div>
          </form>
        </>
      ) : null}

      <ActionsSection d={d} />

      <h2>Timeline</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Verdict</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {d.assessments.map((a) => (
            <tr>
              <td class="small muted">{fmtDate(a.createdAt)}</td>
              <td>
                {a.stage} assessment{' '}
                <span class="muted small">
                  {a.provider}
                  {a.model ? ` · ${a.model}` : ''}
                  {a.role !== 'primary' ? ` · ${a.role}` : ''}
                </span>
              </td>
              <td>
                {a.status !== 'ok' ? (
                  <span class="v v-violation">{a.status}</span>
                ) : (
                  <span class="muted">answers</span>
                )}
              </td>
              <td class="small">
                {a.error ? <span class="error">{a.error}</span> : null}
                {a.rationale ? <div>{a.rationale}</div> : null}
                {a.answers ? <AnswersSummary answers={a.answers} /> : null}
                {a.latencyMs !== null ? <div class="muted">{a.latencyMs} ms</div> : null}
              </td>
            </tr>
          ))}
          {d.decisions.map((x) => (
            <tr>
              <td class="small muted">{fmtDate(x.createdAt)}</td>
              <td>
                {x.stage} decision{' '}
                <span class="muted small">
                  {x.actor} via {x.via}
                </span>
              </td>
              <td>
                <VerdictBadge verdict={x.verdict} category={x.category} />
              </td>
              <td class="small">
                {x.reasons.join('; ')}
                {x.note ? ` — ${x.note}` : ''}
              </td>
            </tr>
          ))}
          {d.reviewItems.map((r) => (
            <tr>
              <td class="small muted">{fmtDate(r.createdAt)}</td>
              <td>queued for a human</td>
              <td>
                {r.resolvedAt ? (
                  <span class="muted">resolved {fmtDate(r.resolvedAt)}</span>
                ) : (
                  <span class="v v-unsure">open</span>
                )}
              </td>
              <td class="small">{r.reason.replace(/_/g, ' ')}</td>
            </tr>
          ))}
          {d.labels.map((l) => (
            <tr>
              <td></td>
              <td>label from {l.source}</td>
              <td>
                <VerdictBadge verdict={l.verdict} />
              </td>
              <td class="small">{l.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};

const AnswersSummary: FC<{ answers: Record<string, unknown> }> = ({ answers }) => (
  <div>
    {Object.entries(answers).map(([id, a]) => {
      const ans = a as {
        type: string;
        choice?: string;
        score?: number;
        noul?: number;
        probabilities?: Record<string, number>;
      };
      const p = ans.probabilities;
      const top =
        ans.type === 'choice'
          ? ans.choice
          : ans.type === 'score'
            ? ans.score?.toFixed(2)
            : ans.noul?.toFixed(2);
      const topP = p && ans.choice ? p[ans.choice] : undefined;
      return (
        <span>
          <b>{id}</b> {top}
          {topP !== undefined ? <span class="muted"> ({topP.toFixed(2)})</span> : null}{' '}
        </span>
      );
    })}
  </div>
);

export const LogPage: FC<{
  rows: LogRow[];
  sources: string[];
  filters: {
    stage?: string | undefined;
    verdict?: string | undefined;
    source?: string | undefined;
  };
}> = ({ rows, sources, filters }) => (
  <>
    <h1>Decision log</h1>
    <form method="get" action={`${BASE}/log`} class="actions">
      <select name="stage">
        <option value="">any stage</option>
        {['s1', 's2', 'human'].map((s) => (
          <option value={s} selected={filters.stage === s}>
            {s}
          </option>
        ))}
      </select>
      <select name="verdict">
        <option value="">any verdict</option>
        {['ok', 'unsure', 'violation'].map((v) => (
          <option value={v} selected={filters.verdict === v}>
            {v}
          </option>
        ))}
      </select>
      <select name="source">
        <option value="">any source</option>
        {sources.map((s) => (
          <option value={s} selected={filters.source === s}>
            {s}
          </option>
        ))}
      </select>
      <button type="submit">Filter</button>
    </form>
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Stage</th>
          <th>Verdict</th>
          <th>By</th>
          <th>Comment</th>
          <th>Reasons</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td class="small muted">{fmtDate(r.createdAt)}</td>
            <td>{r.stage}</td>
            <td>
              <VerdictBadge verdict={r.verdict} category={r.category} />
            </td>
            <td class="small">
              {r.actor} <span class="muted">via {r.via}</span>
            </td>
            <td>
              <a href={`${BASE}/comments/${r.commentId}`}>{truncate(r.text, 100)}</a>{' '}
              <span class="muted small">{r.source}</span>
            </td>
            <td class="small">{r.reasons.join('; ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </>
);

export const AnalyticsPage: FC<{
  days: number;
  o: Overview;
  rows: DailyRow[];
  providers: ProviderStats[];
}> = ({ days, o, rows, providers }) => {
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '–');
  return (
    <>
      <h1>Analytics</h1>
      <form method="get" action={`${BASE}/analytics`} class="actions">
        <span>Last</span>
        {[1, 7, 30, 90].map((d) => (
          <button type="submit" name="days" value={String(d)} class={d === days ? 'primary' : ''}>
            {d} d
          </button>
        ))}
      </form>
      <div class="cards">
        <div class="card">
          <div class="n">{o.ingested}</div>
          <div class="l">comments</div>
        </div>
        <div class="card">
          <div class="n">{pct(o.humanNeeded, o.ingested)}</div>
          <div class="l">needed a human ({o.humanNeeded})</div>
        </div>
        <div class="card">
          <div class="n">{o.s1Flagged}</div>
          <div class="l">flagged by stage 1 ({pct(o.s1Flagged, o.ingested)})</div>
        </div>
        <div class="card">
          <div class="n">{o.s2Flagged}</div>
          <div class="l">flagged by stage 2 of {o.s2Judged} judged</div>
        </div>
        <div class="card">
          <div class="n">{Object.values(o.s2Changed).reduce((a, b) => a + b, 0)}</div>
          <div class="l">changed by stage 2</div>
        </div>
        <div class="card">
          <div class="n">{o.humanOverrides}</div>
          <div class="l">human overrides of {o.humanDecided} decisions</div>
        </div>
        <div class="card">
          <div class="n">{o.reviewOpen}</div>
          <div class="l">open in the queue</div>
        </div>
      </div>

      <h2>Verdicts</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th class="num">ok</th>
            <th class="num">unsure</th>
            <th class="num">violation</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Stage 1</td>
            <td class="num">{o.s1.ok}</td>
            <td class="num">{o.s1.unsure}</td>
            <td class="num">{o.s1.violation}</td>
          </tr>
          <tr>
            <td>Final (closed)</td>
            <td class="num">{o.final.ok}</td>
            <td class="num">{o.final.unsure}</td>
            <td class="num">{o.final.violation}</td>
          </tr>
        </tbody>
      </table>

      <h2>Stage 2 changed stage 1's verdict</h2>
      {Object.keys(o.s2Changed).length === 0 ? (
        <p class="muted">No changes in this window.</p>
      ) : (
        <table>
          <tbody>
            {Object.entries(o.s2Changed).map(([k, n]) => (
              <tr>
                <td>{k.replace('->', ' → ')}</td>
                <td class="num">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Open queue by reason</h2>
      <table>
        <tbody>
          {Object.entries(o.reviewByReason).map(([k, n]) => (
            <tr>
              <td>{k.replace(/_/g, ' ')}</td>
              <td class="num">{n}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Per day</h2>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th class="num">comments</th>
            <th class="num">ok</th>
            <th class="num">unsure</th>
            <th class="num">violation</th>
            <th class="num">human</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>{r.day}</td>
              <td class="num">{r.ingested}</td>
              <td class="num">{r.s1_ok}</td>
              <td class="num">{r.s1_unsure}</td>
              <td class="num">{r.s1_violation}</td>
              <td class="num">{r.human}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Providers</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Stage</th>
            <th class="num">calls</th>
            <th class="num">errors</th>
            <th class="num">mean ms</th>
            <th class="num">p95 ms</th>
            <th class="num">input tokens</th>
            <th class="num">cost $</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr>
              <td>{p.provider}</td>
              <td>{p.stage}</td>
              <td class="num">{p.calls}</td>
              <td class="num">{p.errors}</td>
              <td class="num">{p.meanLatencyMs}</td>
              <td class="num">{p.p95LatencyMs}</td>
              <td class="num">{p.inputTokens}</td>
              <td class="num">{p.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};
