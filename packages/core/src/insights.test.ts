import { describe, it, expect } from 'vitest';
import type { UsageEvent } from '@hypergate/shared';
import { computeInsights, BURST_CALLS } from './insights.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ev = (over: Partial<UsageEvent> & { minsAgo?: number; msAgo?: number }): UsageEvent => {
  const { minsAgo = 5, msAgo, ...rest } = over;
  return {
    at: new Date(NOW - (msAgo ?? minsAgo * 60_000)).toISOString(),
    serverId: 'gh',
    server: 'GitHub',
    tool: 'list',
    client: 'Claude Code',
    ok: true,
    ms: 3,
    bytesIn: 10,
    bytesOut: 10,
    ...rest,
  };
};
const rules = (xs: ReturnType<typeof computeInsights>) => xs.map((i) => i.rule);

describe('computeInsights', () => {
  it('is quiet for ordinary, already-known activity', () => {
    const history = [ev({ minsAgo: 60 * 30 })];
    expect(computeInsights([ev({}), ev({ minsAgo: 3 })], { now: NOW, history })).toEqual([]);
  });

  it('raises a high insight for a vault key that was blocked', () => {
    const out = computeInsights([ev({ blocked: 'secret', ok: false, tool: 'create_issue' })], { now: NOW, history: [ev({ minsAgo: 9999 })] });
    expect(out[0]).toMatchObject({ rule: 'secret-blocked', severity: 'high', tool: 'create_issue', count: 1 });
  });

  it('flags repeated policy refusals as probing, but not one or two', () => {
    const history = [ev({ minsAgo: 9999 })];
    const few = Array.from({ length: 2 }, () => ev({ blocked: 'policy', ok: false }));
    expect(rules(computeInsights(few, { now: NOW, history }))).not.toContain('policy-probing');
    const many = Array.from({ length: 6 }, (_, i) => ev({ blocked: 'policy', ok: false, tool: `t${i}` }));
    expect(rules(computeInsights(many, { now: NOW, history }))).toContain('policy-probing');
  });

  it('flags a first destructive call once, and not when it was seen before the window', () => {
    const cur = [ev({ tool: 'merge', destructive: true }), ev({ tool: 'merge', destructive: true, minsAgo: 2 })];
    const fresh = computeInsights(cur, { now: NOW, history: [ev({ minsAgo: 9999 })] });
    expect(fresh.filter((i) => i.rule === 'first-destructive')).toHaveLength(1);
    const seen = computeInsights(cur, { now: NOW, history: [ev({ minsAgo: 9999, tool: 'merge', destructive: true })] });
    expect(rules(seen)).not.toContain('first-destructive');
  });

  it('detects a burst inside one minute but not the same calls spread out', () => {
    const history = [ev({ minsAgo: 9999 })];
    const burst = Array.from({ length: BURST_CALLS }, (_, i) => ev({ msAgo: 30_000 + i * 100 }));
    expect(rules(computeInsights(burst, { now: NOW, history }))).toContain('burst');
    const spread = Array.from({ length: BURST_CALLS }, (_, i) => ev({ minsAgo: 2 + i * 2 }));
    expect(rules(computeInsights(spread, { now: NOW, history }))).not.toContain('burst');
  });

  it('detects an error spike only with enough calls', () => {
    const history = [ev({ minsAgo: 9999 })];
    const bad = Array.from({ length: 10 }, (_, i) => ev({ ok: i < 3 }));
    expect(rules(computeInsights(bad, { now: NOW, history }))).toContain('error-spike');
    expect(rules(computeInsights(bad.slice(0, 4), { now: NOW, history }))).not.toContain('error-spike');
  });

  it('groups one caller\'s first writes into a single insight', () => {
    const out = computeInsights(
      [ev({ tool: 'a', destructive: true }), ev({ tool: 'b', destructive: true }), ev({ tool: 'c', destructive: true })],
      { now: NOW, history: [ev({ minsAgo: 9999 })] },
    );
    const firsts = out.filter((i) => i.rule === 'first-destructive');
    expect(firsts).toHaveLength(1);
    expect(firsts[0]!.title).toMatch(/3 tools/);
  });

  it('names a new caller, and sorts high before medium before low', () => {
    const out = computeInsights(
      [ev({ client: 'Mystery' }), ev({ client: 'Mystery', blocked: 'secret', ok: false }), ev({ client: 'Mystery', tool: 'drop', destructive: true })],
      { now: NOW },
    );
    expect(rules(out)).toEqual(['secret-blocked', 'first-destructive', 'new-caller']);
  });

  it('ignores events outside the window', () => {
    expect(computeInsights([ev({ minsAgo: 60 * 30, blocked: 'secret', ok: false })], { now: NOW })).toEqual([]);
  });
});
