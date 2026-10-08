import { describe, expect, it, vi } from 'vitest';
import { POLICIES } from '../policy/policy.js';
import { routeGuard, routeOpenAI } from '../policy/scores.js';
import {
  buildGuardPrompt,
  OllamaGuardProvider,
  parseGuardText,
  unsafeProbability,
} from './guard.js';
import { OpenAIModerationProvider } from './openai.js';

const POLICY = POLICIES['severity_led']!;

describe('Llama Guard provider', () => {
  it('writes a raw prompt with our categories and the comment', () => {
    const p = buildGuardPrompt({ text: 'du Vollidiot', context: { post: 'Festival' } });
    expect(p).toContain('S1: Harassment');
    expect(p).toContain('S4: Spam');
    expect(p).toContain('du Vollidiot');
    expect(p).toContain('<|start_header_id|>assistant<|end_header_id|>');
  });

  it('reads P(unsafe) from the first token and the category from the text', () => {
    const tokens = [
      {
        token: 'unsafe',
        logprob: Math.log(0.8),
        top_logprobs: [
          { token: 'unsafe', logprob: Math.log(0.8) },
          { token: 'safe', logprob: Math.log(0.2) },
        ],
      },
      { token: '\n', logprob: 0 },
      { token: 'S', logprob: 0 },
      { token: '1', logprob: 0 },
    ];
    expect(unsafeProbability(tokens, 'unsafe\nS1')).toBeCloseTo(0.8, 5);
    expect(parseGuardText('unsafe\nS1,S3')).toEqual({ unsafe: true, categories: ['S1', 'S3'] });
    expect(parseGuardText('safe')).toEqual({ unsafe: false, categories: [] });
    // split tokenisation: "un" + "safe"
    const split = [
      {
        token: 'un',
        logprob: Math.log(0.6),
        top_logprobs: [
          { token: 'un', logprob: Math.log(0.6) },
          { token: 'safe', logprob: Math.log(0.4) },
        ],
      },
    ];
    expect(unsafeProbability(split, 'unsafe\nS2')).toBeCloseTo(0.6, 5);
  });

  it('assesses through /api/generate with raw mode and logprobs', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: 'llama-guard3:1b',
        response: 'unsafe\nS3',
        prompt_eval_count: 300,
        eval_count: 4,
        logprobs: [
          {
            token: 'unsafe',
            logprob: Math.log(0.9),
            top_logprobs: [
              { token: 'unsafe', logprob: Math.log(0.9) },
              { token: 'safe', logprob: Math.log(0.1) },
            ],
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const p = new OllamaGuardProvider({
      configId: 5,
      name: 'guard',
      baseUrl: 'http://ollama',
      model: 'llama-guard3:1b',
      fetch: fetchImpl,
    });
    const out = await p.assess({ text: "I'll find out where you live" });
    expect(out.status).toBe('ok');
    expect(out.answers?.['unsafe']).toEqual({ type: 'noul', noul: expect.closeTo(0.9, 5) });
    expect(out.answers?.['category']).toMatchObject({ type: 'choice', choice: 'S3' });
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string,
    );
    expect(body).toMatchObject({
      raw: true,
      logprobs: true,
      stream: false,
      model: 'llama-guard3:1b',
    });

    const r = routeGuard(out.answers!, POLICY);
    expect(r).toMatchObject({ verdict: 'violation', category: 'threat' });
    expect(
      routeGuard(
        {
          unsafe: { type: 'noul', noul: 0.5 },
          category: { type: 'choice', choice: 'S1', probabilities: { S1: 1 }, confidence: 1 },
        },
        POLICY,
      ),
    ).toMatchObject({ verdict: 'unsure', category: 'harassment' });
    expect(routeGuard({ unsafe: { type: 'noul', noul: 0.1 } }, POLICY)).toEqual({
      verdict: 'ok',
      category: 'none',
      reasons: [],
    });
  });
});

describe('OpenAI moderation provider', () => {
  it('stores category scores as noul answers and routes on the highest relevant one', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: 'omni-moderation-latest',
        results: [
          {
            flagged: true,
            category_scores: {
              harassment: 0.91,
              'harassment/threatening': 0.3,
              hate: 0.05,
              sexual: 0.01,
              'self-harm': 0.0,
              violence: 0.2,
            },
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const p = new OpenAIModerationProvider({
      configId: 6,
      name: 'openai',
      apiKey: 'sk',
      fetch: fetchImpl,
    });
    const out = await p.assess({ text: 'you idiot', context: { post: 'never sent' } });
    expect(out.status).toBe('ok');
    expect(out.answers?.['harassment']).toEqual({ type: 'noul', noul: 0.91 });
    expect(out.answers?.['harassment_threatening']).toEqual({ type: 'noul', noul: 0.3 });
    const sent = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string,
    );
    expect(sent).toEqual({ model: 'omni-moderation-latest', input: 'you idiot' });

    expect(routeOpenAI(out.answers!, POLICY)).toMatchObject({
      verdict: 'violation',
      category: 'harassment',
    });
    expect(routeOpenAI({ violence: { type: 'noul', noul: 0.5 } }, POLICY)).toMatchObject({
      verdict: 'unsure',
      category: 'threat',
    });
    expect(routeOpenAI({ sexual: { type: 'noul', noul: 0.01 } }, POLICY)).toEqual({
      verdict: 'ok',
      category: 'none',
      reasons: [],
    });
  });
});
