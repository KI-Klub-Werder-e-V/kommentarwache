/** Routing is pure code, so it is tested without any model. Ported from the prototype. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, POLICIES, labelSentiment, routeV1, type V1Answers } from './policy.js';

function make(
  overrides: {
    sentiment?: string;
    sentimentConf?: number;
    hostile?: number;
    target?: string;
    severity?: number;
  } = {},
): V1Answers {
  return {
    sentiment: {
      choice: overrides.sentiment ?? 'neutral',
      confidence: overrides.sentimentConf ?? 0.9,
    },
    hostile: { noul: overrides.hostile ?? 0.02 },
    target: { choice: overrides.target ?? 'nobody', confidence: 0.9 },
    severity: { score: overrides.severity ?? 0.0 },
  };
}

const STRICT = POLICIES['strict']!;
const SEVERITY_LED = POLICIES['severity_led']!;
const PERMISSIVE = POLICIES['permissive']!;
const NAIVE = POLICIES['naive']!;

describe('routeV1', () => {
  it('approves benign comments with no reasons', () => {
    const r = routeV1(make(), STRICT);
    expect(r).toEqual({ verdict: 'ok', category: 'none', reasons: [] });
  });

  it('does not flag a negative product review under strict', () => {
    const r = routeV1(
      make({ sentiment: 'negative', target: 'content_or_product', hostile: 0.05 }),
      STRICT,
    );
    expect(r.verdict).toBe('ok');
  });

  it('naive policy flags negative sentiment alone', () => {
    const r = routeV1(make({ sentiment: 'negative', target: 'content_or_product' }), NAIVE);
    expect(r.verdict).toBe('violation');
    expect(r.reasons[0]).toContain('naive');
  });

  it('hostile in the unsure band', () => {
    expect(routeV1(make({ hostile: 0.5 }), STRICT).verdict).toBe('unsure');
  });

  it('hostile above the violation line', () => {
    const r = routeV1(make({ hostile: 0.9 }), STRICT);
    expect(r.verdict).toBe('violation');
    expect(r.reasons[0]).toMatch(/^hostile/);
  });

  it('severity can be a violation alone', () => {
    expect(routeV1(make({ hostile: 0.1, severity: 2.4 }), STRICT).verdict).toBe('violation');
  });

  it('severity in the unsure band', () => {
    expect(routeV1(make({ hostile: 0.1, severity: 1.2 }), STRICT).verdict).toBe('unsure');
  });

  it('precedence never downgrades', () => {
    const r = routeV1(make({ hostile: 0.9, severity: 1.2 }), STRICT);
    expect(r.verdict).toBe('violation');
    expect(r.reasons).toHaveLength(2);
  });

  it('permissive is looser than strict', () => {
    const a = make({ hostile: 0.75 });
    expect(routeV1(a, STRICT).verdict).toBe('violation');
    expect(routeV1(a, PERMISSIVE).verdict).toBe('unsure');
  });

  it('default policy is severity led', () => {
    expect(DEFAULT_POLICY).toBe('severity_led');
    expect(SEVERITY_LED.v1.hostileViolation).toBeNull();
  });

  it('severity led leaves hostile but merely rude comments unsure', () => {
    const r = routeV1(make({ hostile: 0.9, severity: 1.0 }), SEVERITY_LED);
    expect(r.verdict).toBe('unsure');
    expect(r.category).toBe('rude');
  });

  it('severity led flags on severity alone', () => {
    expect(routeV1(make({ hostile: 0.3, severity: 1.6 }), SEVERITY_LED).verdict).toBe('violation');
    expect(routeV1(make({ hostile: 0.98, severity: 1.47 }), SEVERITY_LED).verdict).toBe('unsure');
  });

  it('maps severity levels to categories', () => {
    expect(routeV1(make({ severity: 2.8 }), SEVERITY_LED).category).toBe('threat');
    expect(routeV1(make({ severity: 2.1 }), SEVERITY_LED).category).toBe('harassment');
    expect(routeV1(make({ severity: 2.1, target: 'group' }), SEVERITY_LED).category).toBe('hate');
  });
});

describe('labelSentiment', () => {
  it('reports low confidence as uncertain', () => {
    expect(labelSentiment(make({ sentiment: 'negative', sentimentConf: 0.4 }), STRICT.v1)).toBe(
      'uncertain',
    );
    expect(labelSentiment(make({ sentiment: 'negative', sentimentConf: 0.8 }), STRICT.v1)).toBe(
      'negative',
    );
  });
});
