/**
 * Meta Graph API connectors for a Facebook Page and an Instagram professional account.
 *
 * Facebook Page
 *   Config:  { "page_id": "1234567890" }
 *   Secrets: { "page_access_token": "EAAB..." }   (Page token with pages_read_user_content,
 *            pages_manage_engagement, pages_manage_metadata; Standard Access is enough for
 *            your own Page when every user has a role on the app)
 *   Actions: hide/unhide (is_hidden), delete, ban/unban (/{page-id}/blocked)
 *
 * Instagram
 *   Config:  { "ig_user_id": "17841400000000000", "api_host": "https://graph.facebook.com" }
 *            (api_host https://graph.instagram.com for Instagram Login tokens)
 *   Secrets: { "access_token": "..." }   (instagram_manage_comments or instagram_business_manage_comments)
 *   Actions: hide/unhide, delete. Instagram has no block endpoint.
 *
 * Both poll: the newest posts, then each post's comments newer than the cursor.
 */

import type {
  ActionResult,
  ActionTarget,
  Capability,
  Connector,
  ConnectorRow,
  NormalizedComment,
  PollResult,
} from './connector.js';
import { form, HttpError, requestJson } from './http.js';

export const GRAPH_VERSION = 'v26.0';

abstract class GraphConnector implements Connector {
  abstract readonly kind: string;
  abstract readonly capabilities: ReadonlySet<Capability>;
  protected readonly host: string;
  protected readonly token: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(row: ConnectorRow, tokenKey: string, fetchImpl: typeof fetch) {
    this.host = String(row.config['api_host'] ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    this.token = String(row.secrets[tokenKey] ?? '');
    this.fetchImpl = fetchImpl;
    if (!this.token) throw new Error(`${row.kind}: secrets.${tokenKey} is required`);
  }

  protected url(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): string {
    return `${this.host}/${GRAPH_VERSION}/${path.replace(/^\//, '')}?${form({ ...params, access_token: this.token })}`;
  }

  protected get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return requestJson<T>(this.url(path, params), { fetchImpl: this.fetchImpl });
  }

  protected async act(
    method: 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<ActionResult> {
    try {
      const response = await requestJson<Record<string, unknown>>(this.url(path, params), {
        method,
        fetchImpl: this.fetchImpl,
      });
      return { ok: true, response };
    } catch (err) {
      return { ok: false, error: err instanceof HttpError ? err.message : (err as Error).message };
    }
  }
}

interface FbComment {
  id: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
  permalink_url?: string;
  parent?: { id?: string };
}

export class FacebookPageConnector extends GraphConnector {
  readonly kind = 'facebook';
  readonly capabilities: ReadonlySet<Capability> = new Set([
    'poll',
    'hide',
    'unhide',
    'delete',
    'ban',
    'unban',
  ]);
  private readonly pageId: string;

  constructor(row: ConnectorRow, fetchImpl: typeof fetch = fetch) {
    super(row, 'page_access_token', fetchImpl);
    this.pageId = String(row.config['page_id'] ?? '');
    if (!this.pageId) throw new Error('facebook: config.page_id is required');
  }

  async check() {
    try {
      const page = await this.get<{ id: string; name?: string }>(this.pageId, {
        fields: 'id,name',
      });
      return { ok: true, detail: `page ${page.name ?? page.id}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async poll(cursor: Record<string, unknown>): Promise<PollResult> {
    const since = typeof cursor['newest'] === 'string' ? Date.parse(cursor['newest']) : 0;
    let newest = since;
    const comments: NormalizedComment[] = [];
    const posts = await this.get<{
      data?: Array<{ id: string; message?: string; permalink_url?: string }>;
    }>(`${this.pageId}/posts`, {
      fields: 'id,message,permalink_url',
      limit: 10,
    });
    for (const post of posts.data ?? []) {
      const res = await this.get<{ data?: FbComment[] }>(`${post.id}/comments`, {
        filter: 'stream',
        order: 'reverse_chronological',
        fields: 'id,message,from{id,name},created_time,permalink_url,parent{id}',
        limit: 100,
      });
      for (const c of res.data ?? []) {
        const t = Date.parse(c.created_time ?? '') || 0;
        if (t <= since) continue;
        newest = Math.max(newest, t);
        comments.push({
          platformCommentId: c.id,
          text: c.message ?? '',
          authorRef: c.from?.id,
          authorName: c.from?.name,
          permalink:
            c.permalink_url ??
            `https://www.facebook.com/${post.id}?comment_id=${c.id.split('_').pop()}`,
          parentPlatformId: c.parent?.id,
          threadRef: post.id,
          platformCreatedAt: c.created_time ? new Date(c.created_time) : undefined,
          context: {
            platform: 'Facebook',
            ...(post.message ? { post: post.message.slice(0, 500) } : {}),
            comment_kind: c.parent ? 'reply to another commenter' : 'top-level comment',
          },
        });
      }
    }
    return {
      comments,
      cursor: { newest: newest ? new Date(newest).toISOString() : (cursor['newest'] ?? null) },
    };
  }

  hide(t: ActionTarget) {
    return this.act('POST', t.platformCommentId, { is_hidden: true });
  }
  unhide(t: ActionTarget) {
    return this.act('POST', t.platformCommentId, { is_hidden: false });
  }
  delete(t: ActionTarget) {
    return this.act('DELETE', t.platformCommentId);
  }
  ban(t: ActionTarget) {
    if (!t.platformAuthorId) return Promise.resolve({ ok: false, error: 'no author id to block' });
    return this.act('POST', `${this.pageId}/blocked`, { user: t.platformAuthorId });
  }
  unban(t: ActionTarget) {
    if (!t.platformAuthorId)
      return Promise.resolve({ ok: false, error: 'no author id to unblock' });
    return this.act('DELETE', `${this.pageId}/blocked`, { user: t.platformAuthorId });
  }
}

interface IgComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
  replies?: { data?: IgComment[] };
}

export class InstagramConnector extends GraphConnector {
  readonly kind = 'instagram';
  readonly capabilities: ReadonlySet<Capability> = new Set(['poll', 'hide', 'unhide', 'delete']);
  private readonly userId: string;

  constructor(row: ConnectorRow, fetchImpl: typeof fetch = fetch) {
    super(row, 'access_token', fetchImpl);
    this.userId = String(row.config['ig_user_id'] ?? '');
    if (!this.userId) throw new Error('instagram: config.ig_user_id is required');
  }

  async check() {
    try {
      const me = await this.get<{ id: string; username?: string }>(this.userId, {
        fields: 'id,username',
      });
      return { ok: true, detail: `account @${me.username ?? me.id}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async poll(cursor: Record<string, unknown>): Promise<PollResult> {
    const since = typeof cursor['newest'] === 'string' ? Date.parse(cursor['newest']) : 0;
    let newest = since;
    const comments: NormalizedComment[] = [];
    const media = await this.get<{
      data?: Array<{ id: string; permalink?: string; caption?: string }>;
    }>(`${this.userId}/media`, {
      fields: 'id,permalink,caption',
      limit: 10,
    });
    for (const m of media.data ?? []) {
      const res = await this.get<{ data?: IgComment[] }>(`${m.id}/comments`, {
        fields:
          'id,text,username,timestamp,from{id,username},replies{id,text,username,timestamp,from{id,username}}',
        limit: 50,
      });
      const push = (c: IgComment, parent: string | undefined) => {
        const t = Date.parse(c.timestamp ?? '') || 0;
        if (t <= since) return;
        newest = Math.max(newest, t);
        comments.push({
          platformCommentId: c.id,
          text: c.text ?? '',
          authorRef: c.from?.id ?? c.username,
          authorName: c.from?.username ?? c.username,
          permalink: m.permalink,
          parentPlatformId: parent,
          threadRef: m.id,
          platformCreatedAt: c.timestamp ? new Date(c.timestamp) : undefined,
          context: {
            platform: 'Instagram',
            ...(m.caption ? { post: m.caption.slice(0, 500) } : {}),
            comment_kind: parent ? 'reply to another commenter' : 'top-level comment',
          },
        });
      };
      for (const c of res.data ?? []) {
        push(c, undefined);
        for (const r of c.replies?.data ?? []) push(r, c.id);
      }
    }
    return {
      comments,
      cursor: { newest: newest ? new Date(newest).toISOString() : (cursor['newest'] ?? null) },
    };
  }

  hide(t: ActionTarget) {
    return this.act('POST', t.platformCommentId, { hide: true });
  }
  unhide(t: ActionTarget) {
    return this.act('POST', t.platformCommentId, { hide: false });
  }
  delete(t: ActionTarget) {
    return this.act('DELETE', t.platformCommentId);
  }
}
