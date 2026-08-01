import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '@hypergate/core';
import type { AnalyticsSnapshot, UsageEvent } from '@hypergate/shared';
import { openStore, type Store } from './store.ts';

/** A usage event with sensible defaults; override what the assertion cares about. */
const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  at: new Date().toISOString(),
  serverId: 'fs',
  server: 'Filesystem',
  tool: 'read_file',
  client: 'Claude Code 2.0',
  ok: true,
  ms: 12,
  bytesIn: 100,
  bytesOut: 900,
  ...over,
});

/**
 * Feed events through a real Supervisor so the aggregates under test are the
 * ones the daemon actually persists (rather than a hand-built snapshot that
 * could drift from `Supervisor.snapshot()`).
 */
const aggregate = (events: UsageEvent[]): AnalyticsSnapshot => {
  const sup = new Supervisor();
  for (const e of events) sup.record(e);
  return sup.snapshot();
};

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hypergate-store-'));
  store = openStore(dir)!;
  expect(store).toBeDefined();
});
afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openStore', () => {
  it('creates the database and reports nothing stored yet', () => {
    expect(existsSync(join(dir, 'hypergate.db'))).toBe(true);
    expect(store.loadSnapshot(2000)).toBeUndefined();
  });
});

describe('usage history', () => {
  it('round-trips events and rebuilds aggregates on reopen', () => {
    const events = [
      event({ tool: 'read_file' }),
      event({ tool: 'write_file', ok: false, error: 'EACCES' }),
      event({ serverId: 'gh', server: 'GitHub', tool: 'create_issue', client: 'Cursor' }),
    ];
    for (const e of events) store.appendEvent(e);
    store.flush(aggregate(events));

    const back = store.events({ limit: 100 });
    expect(back).toHaveLength(3);
    // Newest first, and the failed call keeps its error + ok=false.
    const failed = back.find((e) => e.tool === 'write_file');
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBe('EACCES');

    // Reopening rebuilds totals + per-server + per-client aggregates from the roll-ups.
    store.close();
    const reopened = openStore(dir)!;
    const snap = reopened.loadSnapshot(2000)!;
    expect(snap.totals.calls).toBe(3);
    expect(snap.totals.errors).toBe(1);
    expect(snap.totals.bytesIn).toBe(300);
    expect(snap.servers.map((s) => s.serverId).sort()).toEqual(['fs', 'gh']);
    const fs = snap.servers.find((s) => s.serverId === 'fs')!;
    expect(fs.calls).toBe(2);
    expect(fs.tools.map((t) => t.tool).sort()).toEqual(['read_file', 'write_file']);
    expect(fs.clients).toEqual(['Claude Code 2.0']);
    expect(snap.clients.map((c) => c.client).sort()).toEqual(['Claude Code 2.0', 'Cursor']);
    reopened.close();
  });

  it('keeps history past the 2000-event in-memory ring (the old JSON cap)', () => {
    const events = Array.from({ length: 2500 }, (_, i) => event({ tool: `tool_${i}` }));
    for (const e of events) store.appendEvent(e);
    store.flush(aggregate(events));

    expect(store.events({ limit: 5000 })).toHaveLength(2500);
    // The supervisor's ring only rehydrates the tail, but nothing was discarded.
    expect(store.loadSnapshot(2000).events).toHaveLength(2000);
  });

  it('filters by server, client and time', () => {
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const events = [
      event({ serverId: 'fs', client: 'Cursor' }),
      event({ serverId: 'gh', client: 'Cursor' }),
      event({ serverId: 'gh', client: 'Claude Code 2.0' }),
      event({ serverId: 'gh', client: 'Cursor', at: old }),
    ];
    for (const e of events) store.appendEvent(e);
    store.flush(aggregate(events));

    expect(store.events({ serverId: 'gh', limit: 100 })).toHaveLength(3);
    expect(store.events({ client: 'Cursor', limit: 100 })).toHaveLength(3);
    expect(store.events({ serverId: 'gh', client: 'Cursor', limit: 100 })).toHaveLength(2);
    const since = new Date(Date.now() - 86_400_000).toISOString();
    expect(store.events({ since, limit: 100 })).toHaveLength(3);
  });

  it('buckets an hourly series in SQL, including empty hours', () => {
    const now = Date.now();
    const events = [
      event({ at: new Date(now).toISOString() }),
      event({ at: new Date(now).toISOString() }),
      event({ at: new Date(now - 2 * 3_600_000).toISOString() }),
    ];
    for (const e of events) store.appendEvent(e);
    store.flush(aggregate(events));

    const series = store.hourlySeries(24);
    expect(series).toHaveLength(24);
    expect(series.at(-1)!.calls).toBe(2); // current hour
    expect(series.at(-3)!.calls).toBe(1); // two hours ago
    expect(series.at(-2)!.calls).toBe(0); // the gap between them
    expect(series.reduce((n, b) => n + b.calls, 0)).toBe(3);
  });
});

describe('server logs', () => {
  it('persists log lines in order and scopes them per server', () => {
    store.appendLog('fs', 'first line');
    store.appendLog('fs', 'second line');
    store.appendLog('gh', 'other server');
    store.flush(aggregate([]));

    expect(store.logs('fs').map((l) => l.line)).toEqual(['first line', 'second line']);
    expect(store.logs('gh').map((l) => l.line)).toEqual(['other server']);
    expect(store.logs('nope')).toEqual([]);
    expect(store.logs('fs')[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('survives a reopen, unlike the in-memory ring', () => {
    store.appendLog('fs', 'durable');
    store.flush(aggregate([]));
    store.close();

    const reopened = openStore(dir)!;
    expect(reopened.logs('fs').map((l) => l.line)).toEqual(['durable']);
    reopened.close();
  });
});

describe('prune', () => {
  it('drops rows past the retention window and keeps recent ones', () => {
    const ancient = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const events = [event({ at: ancient }), event()];
    for (const e of events) store.appendEvent(e);
    store.flush(aggregate(events));
    expect(store.events({ limit: 100 })).toHaveLength(2);

    store.prune(); // default retention is 90 days
    const left = store.events({ limit: 100 });
    expect(left).toHaveLength(1);
    expect(left[0].at).not.toBe(ancient);
  });

  it('honours HYPERGATE_RETAIN_USAGE_DAYS=0 as "keep forever"', () => {
    const ancient = new Date(Date.now() - 500 * 86_400_000).toISOString();
    store.appendEvent(event({ at: ancient }));
    store.flush(aggregate([]));
    process.env.HYPERGATE_RETAIN_USAGE_DAYS = '0';
    try {
      store.prune();
      expect(store.events({ limit: 100 })).toHaveLength(1);
    } finally {
      delete process.env.HYPERGATE_RETAIN_USAGE_DAYS;
    }
  });
});

describe('legacy analytics.json migration', () => {
  it('imports the pre-SQLite snapshot once and moves the file aside', () => {
    // A fresh dir with only the old JSON file in it.
    const legacyDir = mkdtempSync(join(tmpdir(), 'hypergate-legacy-'));
    const legacyPath = join(legacyDir, 'analytics.json');
    const events = [event({ tool: 'read_file' }), event({ tool: 'write_file', ok: false })];
    const snap = aggregate(events);
    snap.since = '2026-01-01T00:00:00.000Z';
    writeFileSync(legacyPath, JSON.stringify(snap));

    const migrated = openStore(legacyDir)!;
    const loaded = migrated.loadSnapshot(2000)!;
    expect(loaded.totals.calls).toBe(2);
    expect(loaded.totals.errors).toBe(1);
    expect(loaded.since).toBe('2026-01-01T00:00:00.000Z');
    expect(migrated.events({ limit: 100 })).toHaveLength(2);

    // Moved aside, not deleted, so a downgrade is recoverable.
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    expect(JSON.parse(readFileSync(`${legacyPath}.migrated`, 'utf8')).totals.calls).toBe(2);
    migrated.close();

    // Re-opening must not double-import (the .migrated file is left alone).
    const again = openStore(legacyDir)!;
    expect(again.events({ limit: 100 })).toHaveLength(2);
    again.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it('tolerates a corrupt legacy snapshot', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'hypergate-bad-'));
    writeFileSync(join(badDir, 'analytics.json'), '{ not json at all');
    const s = openStore(badDir)!;
    expect(s).toBeDefined();
    expect(s.loadSnapshot(2000)).toBeUndefined();
    s.close();
    rmSync(badDir, { recursive: true, force: true });
  });
});

describe('flush durability', () => {
  it('drains the queue so a second flush is a no-op', () => {
    store.appendEvent(event());
    store.flush(aggregate([event()]));
    expect(store.events({ limit: 100 })).toHaveLength(1);
    store.flush(aggregate([event()]));
    expect(store.events({ limit: 100 })).toHaveLength(1);
  });

  it('writes aggregates as absolute values, so repeated flushes do not double-count', () => {
    const events = [event(), event()];
    for (const e of events) store.appendEvent(e);
    const snap = aggregate(events);
    store.flush(snap);
    store.flush(snap);
    store.close();

    const reopened = openStore(dir)!;
    expect(reopened.loadSnapshot(2000)!.totals.calls).toBe(2);
    reopened.close();
  });
});
