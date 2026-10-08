import { describe, expect, it } from 'vitest';
import { v2Answers } from '../test/answers.js';
import { POLICIES } from './policy.js';
import { expectedSeverity, routeV2, toV2Answers } from './v2.js';

const DEFAULT = POLICIES['severity_led']!;
const STRICT = POLICIES['strict']!;

const run = (overrides: Parameters<typeof v2Answers>[0], policy = DEFAULT) =>
  routeV2(toV2Answers(v2Answers(overrides)), policy);

describe('expectedSeverity', () => {
  it('is the probability-weighted level index', () => {
    const a = toV2Answers(
      v2Answers({ severity: { benign: 0, rude: 0.5, harassment: 0.5, threat: 0 } }),
    );
    expect(expectedSeverity(a.severity)).toBeCloseTo(1.5);
  });
});

describe('routeV2', () => {
  it('approves a benign comment', () => {
    expect(run({})).toEqual({ verdict: 'ok', category: 'none', reasons: [] });
  });

  it('approves a blunt product review', () => {
    const r = run({
      sentiment: { positive: 0, neutral: 0.1, negative: 0.9 },
      target: {
        nobody: 0,
        content_or_product: 0.95,
        other_commenter: 0.05,
        public_figure: 0,
        group: 0,
        self: 0,
      },
    });
    expect(r.verdict).toBe('ok');
  });

  it('sends mild rudeness toward a fellow commenter to stage 2', () => {
    const r = run({
      attack: { no_attack: 0.2, attacks_person_or_group: 0.8 },
      target: {
        nobody: 0,
        content_or_product: 0,
        other_commenter: 0.9,
        public_figure: 0.1,
        group: 0,
        self: 0,
      },
      severity: { benign: 0.1, rude: 0.85, harassment: 0.05, threat: 0 },
    });
    expect(r).toMatchObject({ verdict: 'unsure', category: 'rude' });
  });

  it('tolerates the same rudeness toward a public figure under the default policy', () => {
    const answers = {
      attack: { no_attack: 0.2, attacks_person_or_group: 0.8 },
      target: {
        nobody: 0,
        content_or_product: 0,
        other_commenter: 0.1,
        public_figure: 0.9,
        group: 0,
        self: 0,
      },
      severity: { benign: 0.1, rude: 0.85, harassment: 0.05, threat: 0 },
    };
    expect(run(answers).verdict).toBe('ok');
    expect(run(answers).reasons.join(' ')).toMatch(/public figure tolerated/);
    expect(run(answers, STRICT).verdict).toBe('unsure');
  });

  it('does not tolerate harassment of a public figure', () => {
    const r = run({
      attack: { no_attack: 0.02, attacks_person_or_group: 0.98 },
      target: {
        nobody: 0,
        content_or_product: 0,
        other_commenter: 0,
        public_figure: 1,
        group: 0,
        self: 0,
      },
      severity: { benign: 0, rude: 0.1, harassment: 0.85, threat: 0.05 },
    });
    expect(r).toMatchObject({ verdict: 'violation', category: 'harassment' });
  });

  it('calls a group attack hate and a threat a threat', () => {
    const hate = run({
      attack: { no_attack: 0.02, attacks_person_or_group: 0.98 },
      target: {
        nobody: 0,
        content_or_product: 0,
        other_commenter: 0,
        public_figure: 0,
        group: 1,
        self: 0,
      },
      severity: { benign: 0, rude: 0.05, harassment: 0.9, threat: 0.05 },
    });
    expect(hate).toMatchObject({ verdict: 'violation', category: 'hate' });
    const threat = run({
      attack: { no_attack: 0.02, attacks_person_or_group: 0.98 },
      target: {
        nobody: 0,
        content_or_product: 0,
        other_commenter: 1,
        public_figure: 0,
        group: 0,
        self: 0,
      },
      severity: { benign: 0, rude: 0, harassment: 0.2, threat: 0.8 },
    });
    expect(threat).toMatchObject({ verdict: 'violation', category: 'threat' });
  });

  it('routes spam on its own track', () => {
    expect(run({ spam: { not_spam: 0.1, spam_or_scam: 0.9 } })).toMatchObject({
      verdict: 'violation',
      category: 'spam',
    });
    expect(run({ spam: { not_spam: 0.4, spam_or_scam: 0.6 } })).toMatchObject({
      verdict: 'unsure',
      category: 'spam',
    });
  });

  it('keeps the first category when a later rule does not raise the verdict', () => {
    const r = run({
      attack: { no_attack: 0.2, attacks_person_or_group: 0.8 },
      target: {
        nobody: 0,
        content_or_product: 0,
        other_commenter: 1,
        public_figure: 0,
        group: 0,
        self: 0,
      },
      // expected severity 1.05: just inside the unsure band
      severity: { benign: 0.05, rude: 0.85, harassment: 0.1, threat: 0 },
      spam: { not_spam: 0.45, spam_or_scam: 0.55 },
    });
    expect(r.verdict).toBe('unsure');
    expect(r.category).toBe('rude');
    expect(r.reasons).toHaveLength(3);
  });

  it('refuses answers from the wrong battery', () => {
    expect(() => toV2Answers({ hostile: { type: 'noul', noul: 0.5 } })).toThrow(/battery v2 needs/);
  });
});
