import { describe, expect, it, vi } from 'vitest';
import { BATTERY_V1 } from '../batteries/v1.js';
import { SystemOneClient, SystemOneError, SystemOneProvider } from './systemone.js';

const GOOD_BODY = {
  model: 'jev-1.13.0',
  answers: {
    hostile: { type: 'noul', noul: 0.9 },
    sentiment: {
      type: 'choice',
      choice: 'negative',
      probabilities: { negative: 1 },
      confidence: 1,
    },
  },
  usage: { input_tokens: 300, output_tokens: 10 },
};

function fetchSequence(responses: Array<() => Response | Error>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(i++, responses.length - 1)]!();
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

describe('SystemOneClient', () => {
  it('sends the bearer key and parses a good response', async () => {
    const fetchImpl = fetchSequence([json(200, GOOD_BODY)]);
    const client = new SystemOneClient({
      baseUrl: 'https://api.example/',
      apiKey: 'k',
      fetch: fetchImpl,
    });
    const { response } = await client.systemOne({ state: 'x', model: 'jev-latest', questions: {} });
    expect(response.model).toBe('jev-1.13.0');
    expect(response.answers['hostile']).toEqual({ type: 'noul', noul: 0.9 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.example/v1/systemone');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k');
  });

  it('retries on 529 and 429, then succeeds', async () => {
    const fetchImpl = fetchSequence([
      json(529, { error: 'overloaded' }),
      json(429, {}, { 'retry-after': '0' }),
      json(200, GOOD_BODY),
    ]);
    const client = new SystemOneClient({
      baseUrl: 'https://api.example',
      fetch: fetchImpl,
      maxRetries: 3,
    });
    const { response } = await client.systemOne({ state: 'x', model: 'm', questions: {} });
    expect(response.usage.input_tokens).toBe(300);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('does not retry a 401 or 422', async () => {
    const fetchImpl = fetchSequence([json(401, { error: 'bad key' })]);
    const client = new SystemOneClient({ baseUrl: 'https://api.example', fetch: fetchImpl });
    await expect(client.systemOne({ state: 'x', model: 'm', questions: {} })).rejects.toThrow(
      SystemOneError,
    );
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('rejects a response that is not in the System One shape', async () => {
    const fetchImpl = fetchSequence([
      json(200, { model: 'm', answers: { q: { type: 'choice' } }, usage: {} }),
    ]);
    const client = new SystemOneClient({ baseUrl: 'https://api.example', fetch: fetchImpl });
    await expect(client.systemOne({ state: 'x', model: 'm', questions: {} })).rejects.toThrow(
      /unexpected response shape/,
    );
  });
});

describe('SystemOneProvider', () => {
  it('turns a response into an assessment outcome with cost', async () => {
    const client = new SystemOneClient({
      baseUrl: 'https://api.example',
      fetch: fetchSequence([json(200, GOOD_BODY)]),
    });
    const provider = new SystemOneProvider({
      configId: 7,
      name: 'jev',
      battery: BATTERY_V1,
      model: 'jev-latest',
      client,
      costPerInputToken: 42 / 1e9,
    });
    const out = await provider.assess({ text: 'hello' });
    expect(out.status).toBe('ok');
    expect(out.modelVersion).toBe('jev-1.13.0');
    expect(out.costUsd).toBeCloseTo(300 * 42e-9, 12);
    expect(out.answers?.['hostile']).toEqual({ type: 'noul', noul: 0.9 });
  });

  it('reports errors instead of throwing, so the pipeline can record them', async () => {
    const client = new SystemOneClient({
      baseUrl: 'https://api.example',
      fetch: fetchSequence([() => new TypeError('fetch failed')]),
      maxRetries: 0,
    });
    const provider = new SystemOneProvider({
      configId: 7,
      name: 'jev',
      battery: BATTERY_V1,
      model: 'm',
      client,
    });
    const out = await provider.assess({ text: 'hello' });
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/network error/);
  });

  it('never sends author information', async () => {
    const fetchImpl = fetchSequence([json(200, GOOD_BODY)]);
    const client = new SystemOneClient({ baseUrl: 'https://api.example', fetch: fetchImpl });
    const provider = new SystemOneProvider({
      configId: 7,
      name: 'jev',
      battery: BATTERY_V1,
      model: 'm',
      client,
    });
    await provider.assess({ text: 'hello', context: { platform: 'test', post: 'a post' } });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const sent = JSON.parse(init.body as string);
    expect(sent.state).toEqual({ comment: 'hello', context: { platform: 'test', post: 'a post' } });
  });
});
