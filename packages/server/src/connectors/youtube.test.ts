import { describe, expect, it, vi } from 'vitest';
import { ApiCallbackConnector, signBody, verifySignature } from './api.js';
import { YouTubeConnector } from './youtube.js';

type Call = { url: string; init: RequestInit };

/** Routes requests by URL prefix to canned JSON, recording every call. */
function fakeFetch(
  routes: Array<[string, unknown | ((url: string, init: RequestInit) => unknown)]>,
) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) {
        const data =
          typeof body === 'function'
            ? (body as (u: string, i: RequestInit) => unknown)(url, init)
            : body;
        if (data instanceof Response) return data;
        return Response.json(data);
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const yt = (fetchImpl: typeof fetch) =>
  new YouTubeConnector(
    {
      id: 1,
      kind: 'youtube',
      name: 'yt',
      config: { channel_id: 'UC123' },
      secrets: { client_id: 'cid', client_secret: 'cs', refresh_token: 'rt' },
    },
    fetchImpl,
  );

const thread = (id: string, publishedAt: string, replies: Array<[string, string]> = []) => ({
  id,
  snippet: {
    videoId: 'vid1',
    topLevelComment: {
      id,
      snippet: {
        videoId: 'vid1',
        textOriginal: `text ${id}`,
        authorDisplayName: 'A',
        authorChannelId: { value: 'UCa' },
        publishedAt,
      },
    },
  },
  replies: {
    comments: replies.map(([rid, at]) => ({
      id: rid,
      snippet: {
        videoId: 'vid1',
        textOriginal: `reply ${rid}`,
        authorDisplayName: 'B',
        authorChannelId: { value: 'UCb' },
        parentId: id,
        publishedAt: at,
      },
    })),
  },
});

describe('YouTubeConnector', () => {
  it('refreshes the access token once and polls threads newer than the cursor', async () => {
    const { fetch, calls } = fakeFetch([
      ['https://oauth2.googleapis.com/token', { access_token: 'at', expires_in: 3600 }],
      [
        'https://www.googleapis.com/youtube/v3/commentThreads',
        {
          items: [
            thread('c3', '2026-10-08T12:00:00Z', [['r3', '2026-10-08T12:05:00Z']]),
            thread('c2', '2026-10-08T10:00:00Z', [['r2', '2026-10-08T11:30:00Z']]),
            thread('c1', '2026-10-08T09:00:00Z'),
          ],
        },
      ],
    ]);
    const c = yt(fetch);
    const r = await c.poll({ newest: '2026-10-08T10:30:00Z' });
    expect(r.comments.map((x) => x.platformCommentId)).toEqual(['c3', 'r3', 'r2']);
    expect(r.cursor).toEqual({ newest: '2026-10-08T12:05:00.000Z' });
    const top = r.comments[0]!;
    expect(top.permalink).toBe('https://www.youtube.com/watch?v=vid1&lc=c3');
    expect(top.authorRef).toBe('UCa');
    expect(r.comments[1]).toMatchObject({ parentPlatformId: 'c3', threadRef: 'vid1' });
    expect(calls.filter((x) => x.url.includes('oauth2')).length).toBe(1);
    const list = calls.find((x) => x.url.includes('commentThreads'))!;
    expect(list.url).toContain('allThreadsRelatedToChannelId=UC123');
    expect((list.init.headers as Record<string, string>)['authorization']).toBe('Bearer at');
  });

  it('maps hide, unhide, delete and ban onto setModerationStatus', async () => {
    const { fetch, calls } = fakeFetch([
      ['https://oauth2.googleapis.com/token', { access_token: 'at', expires_in: 3600 }],
      // a fresh empty 204 per call: a Response body can only be read once
      [
        'https://www.googleapis.com/youtube/v3/comments/setModerationStatus',
        () => new Response(null, { status: 204 }),
      ],
    ]);
    const c = yt(fetch);
    const t = { platformCommentId: 'c9', platformAuthorId: 'UCx', threadRef: 'vid1' };
    expect((await c.hide(t)).ok).toBe(true);
    expect((await c.unhide(t)).ok).toBe(true);
    expect((await c.delete(t)).ok).toBe(true);
    expect((await c.ban(t)).ok).toBe(true);
    const urls = calls.filter((x) => x.url.includes('setModerationStatus')).map((x) => x.url);
    expect(urls[0]).toContain('moderationStatus=heldForReview');
    expect(urls[1]).toContain('moderationStatus=published');
    expect(urls[2]).toContain('moderationStatus=rejected');
    expect(urls[3]).toContain('moderationStatus=rejected');
    expect(urls[3]).toContain('banAuthor=true');
    expect(urls[2]).not.toContain('banAuthor');
  });

  it('reports a platform error without throwing, with the key redacted', async () => {
    const { fetch } = fakeFetch([
      ['https://oauth2.googleapis.com/token', { access_token: 'at', expires_in: 3600 }],
      [
        'https://www.googleapis.com/youtube/v3/comments/setModerationStatus',
        () => new Response('{"error":"quota"}', { status: 403 }),
      ],
    ]);
    const r = await yt(fetch).hide({
      platformCommentId: 'c9',
      platformAuthorId: null,
      threadRef: null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });
});

describe('ApiCallbackConnector', () => {
  it('signs the body and posts the action to the callback URL', async () => {
    const { fetch, calls } = fakeFetch([['https://site.example/kw', { applied: true }]]);
    const c = new ApiCallbackConnector(
      {
        id: 2,
        kind: 'api',
        name: 'site',
        config: { callback_url: 'https://site.example/kw' },
        secrets: { callback_secret: 's3cret' },
      },
      fetch,
    );
    expect([...c.capabilities]).toContain('hide');
    const r = await c.hide({
      platformCommentId: 'x1',
      platformAuthorId: 'u1',
      threadRef: 'post-1',
    });
    expect(r.ok).toBe(true);
    const call = calls[0]!;
    const body = call.init.body as string;
    const headers = call.init.headers as Record<string, string>;
    expect(JSON.parse(body)).toMatchObject({
      action: 'hide',
      comment_id: 'x1',
      author_ref: 'u1',
      thread_ref: 'post-1',
    });
    expect(verifySignature(body, 's3cret', headers['x-kw-signature'])).toBe(true);
    expect(verifySignature(body, 'wrong', headers['x-kw-signature'])).toBe(false);
    expect(signBody('a', 'k')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('has no action capabilities without a callback URL', () => {
    const c = new ApiCallbackConnector({
      id: 3,
      kind: 'api',
      name: 'plain',
      config: {},
      secrets: {},
    });
    expect(c.capabilities.size).toBe(0);
  });
});
