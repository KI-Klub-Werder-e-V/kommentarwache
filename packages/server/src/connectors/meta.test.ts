import { describe, expect, it, vi } from 'vitest';
import { FacebookPageConnector, InstagramConnector } from './meta.js';

function fakeFetch(routes: Array<[RegExp, unknown]>) {
  const calls: Array<{ url: string; method: string }> = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET' });
    for (const [re, body] of routes)
      if (re.test(url)) return body instanceof Response ? body : Response.json(body);
    return new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 400 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('FacebookPageConnector', () => {
  const make = (fetchImpl: typeof fetch) =>
    new FacebookPageConnector(
      {
        id: 1,
        kind: 'facebook',
        name: 'page',
        config: { page_id: 'P1' },
        secrets: { page_access_token: 'TOK' },
      },
      fetchImpl,
    );

  it('polls the newest posts and their comments after the cursor', async () => {
    const { fetch, calls } = fakeFetch([
      [
        /\/v26\.0\/P1\/posts\?/,
        { data: [{ id: 'P1_100', message: 'Festival programme', permalink_url: 'https://fb/p' }] },
      ],
      [
        /\/v26\.0\/P1_100\/comments\?/,
        {
          data: [
            {
              id: '100_3',
              message: 'new reply',
              from: { id: 'U3', name: 'C' },
              created_time: '2026-10-08T12:00:00+0000',
              parent: { id: '100_1' },
              permalink_url: 'https://fb/c3',
            },
            {
              id: '100_2',
              message: 'old',
              from: { id: 'U2', name: 'B' },
              created_time: '2026-10-08T08:00:00+0000',
            },
          ],
        },
      ],
    ]);
    const r = await make(fetch).poll({ newest: '2026-10-08T09:00:00Z' });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatchObject({
      platformCommentId: '100_3',
      authorRef: 'U3',
      parentPlatformId: '100_1',
      threadRef: 'P1_100',
      permalink: 'https://fb/c3',
      context: {
        platform: 'Facebook',
        post: 'Festival programme',
        comment_kind: 'reply to another commenter',
      },
    });
    expect(r.cursor).toEqual({ newest: '2026-10-08T12:00:00.000Z' });
    expect(calls[0]!.url).toContain('access_token=TOK');
    expect(calls[1]!.url).toContain('filter=stream');
  });

  it('maps actions onto the Graph API', async () => {
    const { fetch, calls } = fakeFetch([[/./, { success: true }]]);
    const c = make(fetch);
    const t = { platformCommentId: '100_3', platformAuthorId: 'U3', threadRef: 'P1_100' };
    expect((await c.hide(t)).ok).toBe(true);
    expect((await c.unhide(t)).ok).toBe(true);
    expect((await c.delete(t)).ok).toBe(true);
    expect((await c.ban(t)).ok).toBe(true);
    expect((await c.unban(t)).ok).toBe(true);
    expect(
      calls.map((x) => `${x.method} ${x.url.replace(/access_token=TOK/, '').split('/v26.0/')[1]}`),
    ).toEqual([
      'POST 100_3?is_hidden=true&',
      'POST 100_3?is_hidden=false&',
      'DELETE 100_3?',
      'POST P1/blocked?user=U3&',
      'DELETE P1/blocked?user=U3&',
    ]);
    expect((await c.ban({ ...t, platformAuthorId: null })).ok).toBe(false);
  });

  it('redacts the token in error messages', async () => {
    const { fetch } = fakeFetch([
      [/./, new Response('{"error":{"message":"(#10) permission"}}', { status: 403 })],
    ]);
    const r = await make(fetch).hide({
      platformCommentId: '100_3',
      platformAuthorId: null,
      threadRef: null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('403');
    expect(r.error).not.toContain('TOK');
  });
});

describe('InstagramConnector', () => {
  it('polls media and comments with replies, without a ban capability', async () => {
    const { fetch } = fakeFetch([
      [
        /\/v26\.0\/IG1\/media\?/,
        { data: [{ id: 'M1', permalink: 'https://ig/m1', caption: 'Sunset' }] },
      ],
      [
        /\/v26\.0\/M1\/comments\?/,
        {
          data: [
            {
              id: 'c1',
              text: 'nice',
              username: 'anna',
              timestamp: '2026-10-08T10:00:00+0000',
              from: { id: '9', username: 'anna' },
              replies: {
                data: [
                  {
                    id: 'c1r',
                    text: 'thanks',
                    username: 'owner',
                    timestamp: '2026-10-08T11:00:00+0000',
                  },
                ],
              },
            },
          ],
        },
      ],
    ]);
    const c = new InstagramConnector(
      {
        id: 2,
        kind: 'instagram',
        name: 'ig',
        config: { ig_user_id: 'IG1', api_host: 'https://graph.instagram.com' },
        secrets: { access_token: 'T' },
      },
      fetch,
    );
    expect(c.capabilities.has('ban')).toBe(false);
    const r = await c.poll({});
    expect(r.comments.map((x) => x.platformCommentId)).toEqual(['c1', 'c1r']);
    expect(r.comments[0]).toMatchObject({
      authorRef: '9',
      authorName: 'anna',
      permalink: 'https://ig/m1',
      context: { post: 'Sunset' },
    });
    expect(r.comments[1]).toMatchObject({ parentPlatformId: 'c1', authorRef: 'owner' });
    expect(r.cursor).toEqual({ newest: '2026-10-08T11:00:00.000Z' });
  });
});
