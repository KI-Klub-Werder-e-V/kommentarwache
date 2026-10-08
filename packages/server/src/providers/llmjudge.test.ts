import { describe, expect, it, vi } from 'vitest';
import { STAGE2_DEFAULT } from '../policy/stage2.js';
import { buildMessages, OllamaJudgeProvider, verdictProbabilities } from './llmjudge.js';

const content =
  '{"verdict": "violation", "category": "harassment", "confidence": 0.9, "rationale": "Direct abuse."}';

/** Tokens as Ollama would return them for `content`, with alternatives at the verdict. */
function tokensFor(text: string, verdictAlternatives: Array<[string, number]>) {
  const pieces = text.split(/(?<=[\s:,{}"])|(?=[\s:,{}"])/).filter((p) => p.length);
  return pieces.map((token) => {
    const isVerdict = token === 'violation';
    return {
      token,
      logprob: isVerdict ? Math.log(0.7) : -0.01,
      top_logprobs: isVerdict
        ? verdictAlternatives.map(([t, p]) => ({ token: t, logprob: Math.log(p) }))
        : [],
    };
  });
}

describe('verdictProbabilities', () => {
  it('normalises the mass over the enum alternatives at the verdict token', () => {
    const tokens = tokensFor(content, [
      ['violation', 0.7],
      ['unsure', 0.2],
      ['ok', 0.1],
    ]);
    const p = verdictProbabilities(content, tokens, 'violation')!;
    expect(p.violation).toBeCloseTo(0.7, 5);
    expect(p.unsure).toBeCloseTo(0.2, 5);
    expect(p.ok).toBeCloseTo(0.1, 5);
  });

  it('matches partial tokens like "viol" and "un" when the tokenizer splits the value', () => {
    // '{"verdict": "violation", ...' split the way a tokenizer might, with the sampled
    // token present in its own top_logprobs as Ollama returns it
    const text = '{"verdict": "violation", "category": "harassment"}';
    const pieces = [
      '{"',
      'verdict',
      '": "',
      'viol',
      'ation',
      '", "',
      'category',
      '": "',
      'harassment',
      '"}',
    ];
    expect(pieces.join('')).toBe(text);
    const tokens = pieces.map((token) => ({
      token,
      logprob: token === 'viol' ? Math.log(0.6) : -0.01,
      top_logprobs:
        token === 'viol'
          ? [
              { token: 'viol', logprob: Math.log(0.6) },
              { token: 'un', logprob: Math.log(0.4) },
            ]
          : [],
    }));
    const p = verdictProbabilities(text, tokens, 'violation')!;
    expect(p.violation).toBeCloseTo(0.6, 5);
    expect(p.unsure).toBeCloseTo(0.4, 5);
  });

  it('returns undefined when the verdict token cannot be found', () => {
    expect(verdictProbabilities('{"nope": 1}', [], 'ok')).toBeUndefined();
  });
});

describe('buildMessages', () => {
  it('puts the policy and examples in the system prompt and the thread context with the comment', () => {
    const [system, user] = buildMessages({
      text: 'you idiot',
      context: { post: 'Festival this weekend', parent_comment: 'Looking forward to it!' },
      policy: STAGE2_DEFAULT,
    });
    expect(system!.content).toContain(STAGE2_DEFAULT.policyText.slice(0, 40));
    expect(system!.content).toContain('Examples:');
    expect(user!.content).toContain('The post being commented on: Festival this weekend');
    expect(user!.content).toContain('The comment this replies to: Looking forward to it!');
    expect(user!.content).toContain('you idiot');
  });
});

describe('OllamaJudgeProvider', () => {
  it('parses a structured answer and reads confidence from logprobs', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: 'gemma4:12b',
        message: { role: 'assistant', content },
        prompt_eval_count: 400,
        eval_count: 30,
        logprobs: tokensFor(content, [
          ['violation', 0.8],
          ['unsure', 0.15],
          ['ok', 0.05],
        ]),
      }),
    ) as unknown as typeof fetch;
    const judge = new OllamaJudgeProvider({
      configId: 3,
      name: 'ollama',
      baseUrl: 'http://ollama',
      model: 'gemma4:12b',
      fetch: fetchImpl,
    });
    const out = await judge.judge({ text: 'you idiot', policy: STAGE2_DEFAULT });
    expect(out.status).toBe('ok');
    expect(out.verdict).toBe('violation');
    expect(out.category).toBe('harassment');
    expect(out.confidenceSource).toBe('logprobs');
    expect(out.probabilities?.violation).toBeCloseTo(0.8, 5);
    expect(out.answers?.['verdict']).toMatchObject({ type: 'choice', choice: 'violation' });
    expect(out.usage).toEqual({ input_tokens: 400, output_tokens: 30 });

    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string,
    );
    expect(body).toMatchObject({
      model: 'gemma4:12b',
      stream: false,
      think: false,
      logprobs: true,
    });
    expect(body.format.properties.verdict.enum).toEqual(['ok', 'unsure', 'violation']);
  });

  it('falls back to the self-reported confidence without logprobs', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ model: 'm', message: { content } }),
    ) as unknown as typeof fetch;
    const judge = new OllamaJudgeProvider({
      configId: 3,
      name: 'ollama',
      baseUrl: 'http://ollama',
      model: 'm',
      fetch: fetchImpl,
    });
    const out = await judge.judge({ text: 'x', policy: STAGE2_DEFAULT });
    expect(out.confidenceSource).toBe('self');
    expect(out.probabilities?.violation).toBeCloseTo(0.9, 5);
  });

  it('reports a malformed answer as an error', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ model: 'm', message: { content: '{"verdict":"maybe"}' } }),
    ) as unknown as typeof fetch;
    const judge = new OllamaJudgeProvider({
      configId: 3,
      name: 'ollama',
      baseUrl: 'http://ollama',
      model: 'm',
      fetch: fetchImpl,
    });
    const out = await judge.judge({ text: 'x', policy: STAGE2_DEFAULT });
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/not in schema/);
  });
});
