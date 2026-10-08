import type { FC, PropsWithChildren } from 'hono/jsx';

/** The dashboard lives under one prefix so the API and the pages never share a path. */
export const BASE = '/app';

const CSS = `
:root { --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --ok: #2a7f3f; --unsure: #b7791f; --violation: #b42318; --accent: #1f4e79; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #eaeaea; --muted: #999; --line: #333; --accent: #7fb3e6; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; gap: 1.25rem; align-items: baseline; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
header a { color: var(--fg); text-decoration: none; }
header a.active { font-weight: 600; text-decoration: underline; }
header .brand { font-weight: 700; margin-right: .5rem; }
header .spacer { flex: 1; }
header .who { color: var(--muted); font-size: .9em; }
main { padding: 1rem; max-width: 1200px; margin: 0 auto; }
h1 { font-size: 1.3rem; margin: .25rem 0 1rem; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-bottom: 1px solid var(--line); }
th { font-weight: 600; color: var(--muted); font-size: .85em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.v { display: inline-block; padding: 0 .4em; border-radius: 3px; font-size: .85em; font-weight: 600; color: #fff; }
.v-ok { background: var(--ok); } .v-unsure { background: var(--unsure); } .v-violation { background: var(--violation); }
.muted { color: var(--muted); } .small { font-size: .85em; }
.text { white-space: pre-wrap; }
blockquote.text { margin: .5rem 0 1rem; padding: .75rem 1rem; border-left: 3px solid var(--accent); background: rgba(127,127,127,.08); }
form.inline { display: inline; }
button, select, input[type=text], input[type=email], input[type=password], textarea { font: inherit; padding: .35rem .6rem; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--fg); }
button { cursor: pointer; }
button.ok { border-color: var(--ok); color: var(--ok); } button.violation { border-color: var(--violation); color: var(--violation); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .5rem 0 1rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: .6rem .8rem; }
.card .n { font-size: 1.5rem; font-weight: 700; }
.card .l { color: var(--muted); font-size: .85em; }
.login { max-width: 360px; margin: 4rem auto; }
.login label { display: block; margin: .75rem 0 .25rem; }
.login input { width: 100%; }
.error { color: var(--violation); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
dt { color: var(--muted); }
pre { font-size: .8em; overflow-x: auto; }
`;

export interface LayoutProps {
  title: string;
  active?: 'queue' | 'log' | 'analytics' | 'sources' | undefined;
  moderator?: { name: string } | undefined;
  openCount?: number | undefined;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  active,
  moderator,
  openCount,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · kommentarwache</title>
      <style>{CSS}</style>
      <script src={`${BASE}/htmx.min.js`} defer></script>
    </head>
    <body>
      <header>
        <span class="brand">kommentarwache</span>
        {moderator ? (
          <>
            <a href={`${BASE}/`} class={active === 'queue' ? 'active' : ''}>
              Queue{openCount !== undefined ? ` (${openCount})` : ''}
            </a>
            <a href={`${BASE}/log`} class={active === 'log' ? 'active' : ''}>
              Log
            </a>
            <a href={`${BASE}/analytics`} class={active === 'analytics' ? 'active' : ''}>
              Analytics
            </a>
            <a href={`${BASE}/sources`} class={active === 'sources' ? 'active' : ''}>
              Sources
            </a>
            <span class="spacer"></span>
            <span class="who">{moderator.name}</span>
            <form method="post" action={`${BASE}/logout`} class="inline">
              <button type="submit">Sign out</button>
            </form>
          </>
        ) : null}
      </header>
      <main>{children}</main>
    </body>
  </html>
);

export const VerdictBadge: FC<{
  verdict: string | null | undefined;
  category?: string | null | undefined;
}> = ({ verdict, category }) =>
  verdict ? (
    <span class={`v v-${verdict}`} title={category ?? ''}>
      {verdict}
      {category && category !== 'none' ? ` · ${category}` : ''}
    </span>
  ) : (
    <span class="muted">–</span>
  );

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

export function truncate(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
