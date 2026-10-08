/** A small JSON HTTP helper for connectors, with a timeout and readable errors. */

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

export async function requestJson<T = Record<string, unknown>>(
  url: string,
  init: RequestInit & { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<T> {
  const { fetchImpl = fetch, timeoutMs = 20_000, ...rest } = init;
  const res = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok)
    throw new HttpError(res.status, text, url.replace(/([?&](access_token|key)=)[^&]+/g, '$1…'));
  return (text ? JSON.parse(text) : {}) as T;
}

export function form(data: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) p.set(k, String(v));
  return p;
}
