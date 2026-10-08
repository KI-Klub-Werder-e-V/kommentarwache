/**
 * The generic source: a site POSTs its comments to /v1/moderate and, if it configures a
 * callback URL, receives the actions back as signed HTTP calls. No platform API, no
 * approval process; the site applies the action itself.
 *
 * Config:  { "callback_url": "https://example.org/kw/actions" }
 * Secrets: { "callback_secret": "..." }  (HMAC-SHA256 over the raw body, header X-KW-Signature)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ActionResult,
  ActionTarget,
  Capability,
  Connector,
  ConnectorRow,
} from './connector.js';
import { HttpError, requestJson } from './http.js';

export interface CallbackPayload {
  action: 'hide' | 'unhide' | 'delete' | 'ban' | 'unban';
  comment_id: string;
  author_ref: string | null;
  thread_ref: string | null;
  sent_at: string;
}

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** For sites verifying what we sent (documented in docs/connectors.md). */
export function verifySignature(body: string, secret: string, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(body, secret));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export class ApiCallbackConnector implements Connector {
  readonly kind = 'api';
  readonly capabilities: ReadonlySet<Capability>;
  private readonly url: string | undefined;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(row: ConnectorRow, fetchImpl: typeof fetch = fetch) {
    this.url =
      typeof row.config['callback_url'] === 'string'
        ? (row.config['callback_url'] as string)
        : undefined;
    this.secret =
      typeof row.secrets['callback_secret'] === 'string'
        ? (row.secrets['callback_secret'] as string)
        : '';
    this.fetchImpl = fetchImpl;
    this.capabilities = new Set(this.url ? ['hide', 'unhide', 'delete', 'ban', 'unban'] : []);
  }

  private async send(action: CallbackPayload['action'], t: ActionTarget): Promise<ActionResult> {
    if (!this.url) return { ok: false, error: 'no callback_url configured' };
    const payload: CallbackPayload = {
      action,
      comment_id: t.platformCommentId,
      author_ref: t.platformAuthorId,
      thread_ref: t.threadRef,
      sent_at: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    try {
      const response = await requestJson(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kw-signature': signBody(body, this.secret),
          'x-kw-action': action,
        },
        body,
        fetchImpl: this.fetchImpl,
      });
      return { ok: true, response };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof HttpError ? err.message : `callback failed: ${(err as Error).message}`,
      };
    }
  }

  hide(t: ActionTarget) {
    return this.send('hide', t);
  }
  unhide(t: ActionTarget) {
    return this.send('unhide', t);
  }
  delete(t: ActionTarget) {
    return this.send('delete', t);
  }
  ban(t: ActionTarget) {
    return this.send('ban', t);
  }
  unban(t: ActionTarget) {
    return this.send('unban', t);
  }
}
