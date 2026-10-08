/**
 * YouTube Data API v3 as a moderation connector for a channel you own.
 *
 * Config:  { "channel_id": "UC..." }
 * Secrets: { "client_id": "...", "client_secret": "...", "refresh_token": "..." }
 *          from a Google OAuth client with the scope
 *          https://www.googleapis.com/auth/youtube.force-ssl, authorised as the channel owner.
 *
 * Polling reads commentThreads.list for the channel (1 quota unit per page). Actions go
 * through comments.setModerationStatus (50 units): hide is heldForReview, unhide is
 * published, delete is rejected (YouTube cannot republish a rejected comment), and ban is
 * rejected with banAuthor=true. The default quota of 10,000 units a day covers about 200
 * moderation calls after polling.
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

const API = 'https://www.googleapis.com/youtube/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface Snippet {
  videoId?: string;
  textOriginal?: string;
  textDisplay?: string;
  authorDisplayName?: string;
  authorChannelId?: { value?: string };
  parentId?: string;
  publishedAt?: string;
  updatedAt?: string;
}
interface CommentResource {
  id: string;
  snippet: Snippet;
}
interface ThreadResource {
  id: string;
  snippet: { videoId?: string; topLevelComment: CommentResource; totalReplyCount?: number };
  replies?: { comments: CommentResource[] };
}

export class YouTubeConnector implements Connector {
  readonly kind = 'youtube';
  readonly capabilities: ReadonlySet<Capability> = new Set([
    'poll',
    'hide',
    'unhide',
    'delete',
    'ban',
  ]);
  private readonly channelId: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(row: ConnectorRow, fetchImpl: typeof fetch = fetch) {
    this.channelId = String(row.config['channel_id'] ?? '');
    this.clientId = String(row.secrets['client_id'] ?? '');
    this.clientSecret = String(row.secrets['client_secret'] ?? '');
    this.refreshToken = String(row.secrets['refresh_token'] ?? '');
    this.fetchImpl = fetchImpl;
    if (!this.channelId) throw new Error('youtube: config.channel_id is required');
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await requestJson<{ access_token: string; expires_in: number }>(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
      fetchImpl: this.fetchImpl,
    });
    this.token = { value: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return res.access_token;
  }

  private async api<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    method = 'GET',
  ): Promise<T> {
    const token = await this.accessToken();
    const url = `${API}/${path}?${form(params)}`;
    return requestJson<T>(url, {
      method,
      headers: { authorization: `Bearer ${token}` },
      fetchImpl: this.fetchImpl,
    });
  }

  async check() {
    try {
      const res = await this.api<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(
        'channels',
        {
          part: 'snippet',
          id: this.channelId,
        },
      );
      const item = res.items?.[0];
      return item
        ? { ok: true, detail: `channel ${item.snippet?.title ?? item.id}` }
        : { ok: false, detail: 'channel not found' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /**
   * Newest threads first, with up to five replies each; stops at the cursor's newest
   * timestamp. The cursor is the newest `publishedAt` seen.
   */
  async poll(cursor: Record<string, unknown>): Promise<PollResult> {
    const since = typeof cursor['newest'] === 'string' ? Date.parse(cursor['newest']) : 0;
    const comments: NormalizedComment[] = [];
    let newest = since;
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await this.api<{ items?: ThreadResource[]; nextPageToken?: string }>(
        'commentThreads',
        {
          part: 'snippet,replies',
          allThreadsRelatedToChannelId: this.channelId,
          order: 'time',
          textFormat: 'plainText',
          maxResults: 100,
          pageToken,
        },
      );
      let reachedCursor = false;
      for (const thread of res.items ?? []) {
        const top = thread.snippet.topLevelComment;
        const topTime = Date.parse(top.snippet.publishedAt ?? '') || 0;
        if (topTime <= since) {
          reachedCursor = true;
          continue; // its replies may still be new; checked below
        }
        comments.push(
          this.normalize(top, thread.snippet.videoId ?? top.snippet.videoId, undefined),
        );
        newest = Math.max(newest, topTime);
      }
      for (const thread of res.items ?? []) {
        for (const reply of thread.replies?.comments ?? []) {
          const t = Date.parse(reply.snippet.publishedAt ?? '') || 0;
          if (t <= since) continue;
          comments.push(
            this.normalize(
              reply,
              thread.snippet.videoId ?? reply.snippet.videoId,
              thread.snippet.topLevelComment.id,
            ),
          );
          newest = Math.max(newest, t);
        }
      }
      pageToken = res.nextPageToken;
      if (reachedCursor || !pageToken) break;
    }
    return {
      comments,
      cursor: { newest: newest ? new Date(newest).toISOString() : (cursor['newest'] ?? null) },
    };
  }

  private normalize(
    c: CommentResource,
    videoId: string | undefined,
    parentId: string | undefined,
  ): NormalizedComment {
    const s = c.snippet;
    return {
      platformCommentId: c.id,
      text: s.textOriginal ?? s.textDisplay ?? '',
      authorRef: s.authorChannelId?.value,
      authorName: s.authorDisplayName,
      permalink: videoId ? `https://www.youtube.com/watch?v=${videoId}&lc=${c.id}` : undefined,
      parentPlatformId: parentId ?? s.parentId,
      threadRef: videoId,
      platformCreatedAt: s.publishedAt ? new Date(s.publishedAt) : undefined,
      context: { platform: 'YouTube', comment_kind: parentId ? 'reply' : 'top-level comment' },
    };
  }

  private async setStatus(
    t: ActionTarget,
    status: 'heldForReview' | 'published' | 'rejected',
    banAuthor = false,
  ): Promise<ActionResult> {
    try {
      const token = await this.accessToken();
      const params = form({
        id: t.platformCommentId,
        moderationStatus: status,
        banAuthor: banAuthor || undefined,
      });
      await requestJson(`${API}/comments/setModerationStatus?${params}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        fetchImpl: this.fetchImpl,
      });
      return { ok: true, response: { moderationStatus: status, banAuthor } };
    } catch (err) {
      return { ok: false, error: err instanceof HttpError ? err.message : (err as Error).message };
    }
  }

  hide(t: ActionTarget) {
    return this.setStatus(t, 'heldForReview');
  }
  unhide(t: ActionTarget) {
    return this.setStatus(t, 'published');
  }
  delete(t: ActionTarget) {
    return this.setStatus(t, 'rejected');
  }
  /** YouTube bans through the comment: rejected plus banAuthor. */
  ban(t: ActionTarget) {
    return this.setStatus(t, 'rejected', true);
  }
}
