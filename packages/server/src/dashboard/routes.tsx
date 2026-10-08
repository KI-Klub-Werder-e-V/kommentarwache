/**
 * The moderator dashboard: server-rendered pages, forms and a little htmx. Every page
 * behind a session; every state change through the same functions the API uses.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Kysely } from 'kysely';
import { CategorySchema, VerdictSchema } from '@kommentarwache/contract';
import { daily, overview, providerStats } from '../analytics/queries.js';
import { appendAudit } from '../audit.js';
import {
  clearSessionCookie,
  login,
  logout,
  requireModerator,
  sameOriginOnly,
  SESSION_COOKIE,
  setSessionCookie,
  type SessionEnv,
} from '../auth/session.js';
import type { DB } from '../db/types.js';
import { executeProposed, manualAction, undoAction } from '../actions/engine.js';
import { listSourcesWithModes, setConnectorModes } from '../connectors/modes.js';
import type { ConnectorActionMode } from '../db/types.js';
import type { ActivePipeline } from '../providers/registry.js';
import { decideComment } from '../review/decide.js';
import { commentDetail, listLog, listQueue, listSources } from '../review/queries.js';
import { SourcesPage } from './sources.js';
import { BASE, Layout } from './layout.js';
import { AnalyticsPage, CommentPage, LoginPage, LogPage, QueuePage } from './pages.js';

const HTMX_PATH = createRequire(import.meta.url).resolve('htmx.org/dist/htmx.min.js');

export function dashboardRoutes(db: Kysely<DB>, pipeline: () => Promise<ActivePipeline>) {
  const app = new Hono<SessionEnv>({ strict: false });

  app.get('/htmx.min.js', async (c) => {
    const js = await readFile(HTMX_PATH);
    return c.body(js, 200, {
      'content-type': 'application/javascript',
      'cache-control': 'public, max-age=86400',
    });
  });

  app.get('/login', (c) =>
    c.html(
      <Layout title="Sign in">
        <LoginPage next={c.req.query('next')} />
      </Layout>,
    ),
  );

  app.post('/login', sameOriginOnly, async (c) => {
    const form = await c.req.parseBody();
    const email = String(form['email'] ?? '');
    const password = String(form['password'] ?? '');
    const next = safeNext(String(form['next'] ?? `${BASE}/`));
    const result = await login(db, email, password);
    if (!result) {
      await appendAudit(db, {
        actorId: null,
        via: 'dashboard',
        event: 'login.failed',
        payload: { email },
      });
      return c.html(
        <Layout title="Sign in">
          <LoginPage error="Email or password is wrong." next={next} />
        </Layout>,
        401,
      );
    }
    setSessionCookie(c, result.sessionId);
    await appendAudit(db, { actorId: result.moderator.id, via: 'dashboard', event: 'login' });
    return c.redirect(next);
  });

  app.post('/logout', sameOriginOnly, async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) await logout(db, sessionId);
    clearSessionCookie(c);
    return c.redirect(`${BASE}/login`);
  });

  app.use('*', requireModerator(db), sameOriginOnly);

  app.get('/', async (c) => {
    const items = await listQueue(db);
    return c.html(
      <Layout title="Queue" active="queue" moderator={c.get('moderator')} openCount={items.length}>
        <QueuePage items={items} />
      </Layout>,
    );
  });

  app.get('/comments/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const d = Number.isInteger(id) ? await commentDetail(db, id) : null;
    if (!d) return c.notFound();
    const queue = await listQueue(db, 50);
    const idx = queue.findIndex((q) => q.commentId === id);
    const nextInQueue = idx >= 0 ? queue[idx + 1]?.commentId : undefined;
    return c.html(
      <Layout
        title={`Comment #${id}`}
        active="queue"
        moderator={c.get('moderator')}
        openCount={queue.length}
      >
        <CommentPage d={d} nextInQueue={nextInQueue} />
      </Layout>,
    );
  });

  app.post('/comments/:id/decide', async (c) => {
    const id = Number(c.req.param('id'));
    const form = await c.req.parseBody();
    const verdict = VerdictSchema.safeParse(form['verdict']);
    const category = CategorySchema.safeParse(form['category']);
    if (!Number.isInteger(id) || !verdict.success || verdict.data === 'unsure')
      return c.text('bad request', 400);
    const note = String(form['note'] ?? '').trim();
    const p = await pipeline();
    await decideComment(
      db,
      {
        commentId: id,
        verdict: verdict.data,
        category: category.success ? category.data : 'other',
        note: note || undefined,
        actorId: c.get('moderator').id,
        via: 'dashboard',
      },
      { connectors: p.connectors, secretKey: p.secretKey, policy: p.policy },
    );
    const next = String(form['next'] ?? '');
    return c.redirect(/^\d+$/.test(next) ? `${BASE}/comments/${next}` : `${BASE}/`);
  });

  // Platform actions from the comment page: a moderator's own hide/delete/ban, executing
  // a proposal, or undoing a hide or ban.
  app.post('/comments/:id/action', async (c) => {
    const id = Number(c.req.param('id'));
    const form = await c.req.parseBody();
    const op = String(form['op'] ?? '');
    const p = await pipeline();
    const engine = { connectors: p.connectors, secretKey: p.secretKey };
    const actorId = c.get('moderator').id;
    if (op === 'hide' || op === 'delete' || op === 'ban') {
      await manualAction(db, engine, { commentId: id, type: op, actorId, via: 'dashboard' });
    } else if (/^execute:\d+$/.test(op)) {
      await executeProposed(db, engine, Number(op.slice(8)), actorId, 'dashboard');
    } else if (/^undo:\d+$/.test(op)) {
      await undoAction(db, engine, Number(op.slice(5)), actorId, 'dashboard');
    } else {
      return c.text('bad request', 400);
    }
    return c.redirect(`${BASE}/comments/${id}`);
  });

  app.get('/sources', async (c) => {
    const [sources, queue] = await Promise.all([listSourcesWithModes(db), listQueue(db, 1000)]);
    return c.html(
      <Layout
        title="Sources"
        active="sources"
        moderator={c.get('moderator')}
        openCount={queue.length}
      >
        <SourcesPage sources={sources} />
      </Layout>,
    );
  });

  app.post('/sources/:id/modes', async (c) => {
    const id = Number(c.req.param('id'));
    const form = await c.req.parseBody();
    const modes = {} as Record<'hide' | 'delete' | 'ban', ConnectorActionMode>;
    for (const type of ['hide', 'delete', 'ban'] as const) {
      const v = String(form[type] ?? 'off');
      modes[type] = (['off', 'dry_run', 'propose', 'auto'] as const).includes(
        v as ConnectorActionMode,
      )
        ? (v as ConnectorActionMode)
        : 'off';
    }
    const cap = Number(form['max_per_hour']);
    await setConnectorModes(
      db,
      id,
      modes,
      Number.isInteger(cap) && cap > 0 ? cap : null,
      c.get('moderator').id,
      'dashboard',
    );
    return c.redirect(`${BASE}/sources`);
  });

  app.get('/log', async (c) => {
    const filters = {
      stage: c.req.query('stage') || undefined,
      verdict: c.req.query('verdict') || undefined,
      source: c.req.query('source') || undefined,
    };
    const [rows, sources, queue] = await Promise.all([
      listLog(db, filters),
      listSources(db),
      listQueue(db, 1000),
    ]);
    return c.html(
      <Layout title="Log" active="log" moderator={c.get('moderator')} openCount={queue.length}>
        <LogPage rows={rows} sources={sources} filters={filters} />
      </Layout>,
    );
  });

  app.get('/analytics', async (c) => {
    const days = [1, 7, 30, 90].includes(Number(c.req.query('days')))
      ? Number(c.req.query('days'))
      : 7;
    const since = new Date(Date.now() - days * 86_400_000);
    const [o, rows, providers, queue] = await Promise.all([
      overview(db, { since }),
      daily(db, { since }),
      providerStats(db, { since }),
      listQueue(db, 1000),
    ]);
    return c.html(
      <Layout
        title="Analytics"
        active="analytics"
        moderator={c.get('moderator')}
        openCount={queue.length}
      >
        <AnalyticsPage days={days} o={o} rows={rows} providers={providers} />
      </Layout>,
    );
  });

  return app;
}

/** Only same-site paths may follow a login. */
function safeNext(next: string): string {
  return next.startsWith(`${BASE}/`) ? next : `${BASE}/`;
}
