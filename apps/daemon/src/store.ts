import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { AnalyticsSnapshot, UsageEvent } from '@hypergate/shared';

/**
 * The durable local store: SQLite (WAL) at `~/.hypergate/hypergate.db`.
 *
 * Replaces the old whole-file `analytics.json` rewrite, which round-tripped the
 * entire snapshot every 2s and capped history at the supervisor's 2000-event
 * ring — fine for a counter, useless for logging and usage review. Here:
 *
 *   • `usage_events` is append-only and unbounded (pruned by age, not count),
 *     so "which tool did which client call last Tuesday" is answerable.
 *   • `agg_*` + `totals` are rolled-up upserts, so boot cost is O(distinct
 *     servers × tools + clients) rather than a replay of every call ever.
 *   • `server_logs` persists stderr per server, so logs survive a restart.
 *
 * Everything stays on the machine. This is the user's own audit trail (SPEC §1
 * "See everything"), never telemetry — nothing here is ever uploaded.
 */

/** Bump when the schema changes in a way that needs migration. */
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT    NOT NULL,
  server_id TEXT    NOT NULL,
  server    TEXT    NOT NULL,
  tool      TEXT    NOT NULL,
  client    TEXT    NOT NULL,
  ok        INTEGER NOT NULL,
  ms        INTEGER NOT NULL,
  bytes_in  INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  error     TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_at        ON usage_events (at);
CREATE INDEX IF NOT EXISTS idx_usage_server_at ON usage_events (server_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_client_at ON usage_events (client, at);

CREATE TABLE IF NOT EXISTS agg_servers (
  server_id TEXT PRIMARY KEY,
  name      TEXT    NOT NULL,
  calls     INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  bytes_in  INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  total_ms  INTEGER NOT NULL DEFAULT 0,
  last_used TEXT
);

CREATE TABLE IF NOT EXISTS agg_server_clients (
  server_id TEXT NOT NULL,
  client    TEXT NOT NULL,
  PRIMARY KEY (server_id, client)
);

CREATE TABLE IF NOT EXISTS agg_tools (
  server_id TEXT    NOT NULL,
  tool      TEXT    NOT NULL,
  calls     INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  total_ms  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, tool)
);

CREATE TABLE IF NOT EXISTS agg_clients (
  client    TEXT PRIMARY KEY,
  calls     INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  bytes_in  INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  last_used TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS totals (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  calls     INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  bytes_in  INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS server_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  server_id TEXT NOT NULL,
  line      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_server_id ON server_logs (server_id, id);
CREATE INDEX IF NOT EXISTS idx_logs_at        ON server_logs (at);
`;

/** How long durable rows are kept. Override with HYPERGATE_RETAIN_*_DAYS (0 = forever). */
const retainDays = (envVar: string, fallback: number): number => {
  const raw = process.env[envVar];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** One durable log line, as served to the UI. */
export interface LogRow {
  at: string;
  serverId: string;
  line: string;
}

/** A page of durable usage history. */
export interface UsageQuery {
  limit?: number;
  serverId?: string;
  client?: string;
  /** ISO timestamp; only events at or after this are returned. */
  since?: string;
}

export interface Store {
  /** Queue one call for durable insert (O(1); the write happens on flush). */
  appendEvent: (e: UsageEvent) => void;
  /** Queue one server log line for durable insert. */
  appendLog: (serverId: string, line: string) => void;
  /** Write queued rows + the rolled-up aggregates in one transaction. */
  flush: (snapshot: AnalyticsSnapshot) => void;
  /** Rebuild the in-memory analytics state on boot (aggregates + a recent-event tail). */
  loadSnapshot: (eventTail: number) => AnalyticsSnapshot | undefined;
  /** Durable usage history, newest first. */
  events: (q: UsageQuery) => UsageEvent[];
  /** Durable log lines for one server, oldest first (matches the old in-memory order). */
  logs: (serverId: string, limit?: number) => LogRow[];
  /** Hourly call counts for the last `hours` hours, oldest first. Computed in SQL, so it is correct beyond the in-memory ring. */
  hourlySeries: (hours: number) => { t: string; calls: number }[];
  /** Delete rows past the retention window. Safe to call repeatedly. */
  prune: () => void;
  close: () => void;
}

/**
 * Open (creating if needed) the store. Returns `undefined` when SQLite is
 * unavailable, so the daemon degrades to in-memory analytics rather than
 * refusing to boot.
 */
export const openStore = (dataDir: string): Store | undefined => {
  // `node:sqlite` is still flagged experimental and warns on first use. The
  // warning is harmless but noisy in a resident daemon (and in `--stdio` mode
  // every stderr line is user-visible), so drop just that one.
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const msg = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (/SQLite is an experimental feature/i.test(msg)) return;
    (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

  let DatabaseSync: new (path: string) => SqliteDb;
  try {
    // Node ≥22.5 ships this; older runtimes fall through to in-memory analytics.
    // A sync require (not `await import`) keeps openStore() synchronous, so the
    // daemon has a usable store before it serves its first request.
    const req = createRequire(import.meta.url);
    ({ DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb });
  } catch {
    return undefined;
  }

  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'hypergate.db');
  let db: SqliteDb;
  try {
    db = new DatabaseSync(dbPath);
    // WAL: concurrent readers (the CLI, a second daemon probe) never block the
    // writer, and a crash can't leave a half-written snapshot the way the old
    // whole-file JSON rewrite could.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
  } catch {
    return undefined;
  }

  const getMeta = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  };
  const setMeta = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  setMeta.run('schema_version', String(SCHEMA_VERSION));

  // ── prepared statements (compiled once, reused per flush) ──────────────────
  const insEvent = db.prepare(
    `INSERT INTO usage_events (at, server_id, server, tool, client, ok, ms, bytes_in, bytes_out, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insLog = db.prepare('INSERT INTO server_logs (at, server_id, line) VALUES (?, ?, ?)');
  const upServer = db.prepare(
    `INSERT INTO agg_servers (server_id, name, calls, errors, bytes_in, bytes_out, total_ms, last_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       name = excluded.name, calls = excluded.calls, errors = excluded.errors,
       bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out,
       total_ms = excluded.total_ms, last_used = excluded.last_used`,
  );
  const upServerClient = db.prepare(
    'INSERT INTO agg_server_clients (server_id, client) VALUES (?, ?) ON CONFLICT(server_id, client) DO NOTHING',
  );
  const upTool = db.prepare(
    `INSERT INTO agg_tools (server_id, tool, calls, errors, total_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(server_id, tool) DO UPDATE SET
       calls = excluded.calls, errors = excluded.errors, total_ms = excluded.total_ms`,
  );
  const upClient = db.prepare(
    `INSERT INTO agg_clients (client, calls, errors, bytes_in, bytes_out, last_used) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client) DO UPDATE SET
       calls = excluded.calls, errors = excluded.errors, bytes_in = excluded.bytes_in,
       bytes_out = excluded.bytes_out, last_used = excluded.last_used`,
  );
  const upTotals = db.prepare(
    `INSERT INTO totals (id, calls, errors, bytes_in, bytes_out) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       calls = excluded.calls, errors = excluded.errors,
       bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out`,
  );

  // Pending rows, drained on flush. Capped so a persistently failing write
  // can't grow the queue without bound (we drop the oldest, and the aggregates
  // still carry the counts, so only the itemised feed loses entries).
  const QUEUE_CAP = 20_000;
  let pendingEvents: UsageEvent[] = [];
  let pendingLogs: { at: string; serverId: string; line: string }[] = [];

  /**
   * One-time import of the pre-SQLite `analytics.json`. The old file only ever
   * held a 2000-event tail plus aggregates, so this is all the history that
   * exists — but it means upgrading users keep their totals and `since`.
   */
  const importLegacyJson = (): void => {
    if (getMeta('legacy_imported') === 'yes') return;
    const legacy = join(dataDir, 'analytics.json');
    let snap: AnalyticsSnapshot | undefined;
    try {
      if (existsSync(legacy)) snap = JSON.parse(readFileSync(legacy, 'utf8')) as AnalyticsSnapshot;
    } catch {
      /* corrupt legacy snapshot: nothing to import */
    }
    if (snap && typeof snap === 'object') {
      try {
        db.exec('BEGIN');
        writeAggregates(snap);
        for (const e of snap.events ?? []) {
          insEvent.run(e.at, e.serverId, e.server, e.tool, e.client, e.ok ? 1 : 0, e.ms, e.bytesIn, e.bytesOut, e.error ?? null);
        }
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
      }
    }
    setMeta.run('legacy_imported', 'yes');
    // Move it aside rather than delete, so a downgrade or a bug is recoverable.
    try {
      if (existsSync(legacy)) renameSync(legacy, `${legacy}.migrated`);
    } catch {
      /* best-effort */
    }
  };

  /** Upsert the rolled-up aggregates from a snapshot. Caller owns the transaction. */
  function writeAggregates(snap: AnalyticsSnapshot): void {
    if (snap.since) setMeta.run('since', snap.since);
    const t = snap.totals;
    if (t) upTotals.run(t.calls ?? 0, t.errors ?? 0, t.bytesIn ?? 0, t.bytesOut ?? 0);
    for (const s of snap.servers ?? []) {
      upServer.run(s.serverId, s.name ?? s.serverId, s.calls, s.errors, s.bytesIn, s.bytesOut, s.totalMs, s.lastUsed ?? null);
      for (const c of s.clients ?? []) upServerClient.run(s.serverId, c);
      for (const tool of s.tools ?? []) upTool.run(s.serverId, tool.tool, tool.calls, tool.errors, tool.totalMs);
    }
    for (const c of snap.clients ?? []) {
      upClient.run(c.client, c.calls, c.errors, c.bytesIn, c.bytesOut, c.lastUsed);
    }
  }

  const store: Store = {
    appendEvent: (e) => {
      pendingEvents.push(e);
      if (pendingEvents.length > QUEUE_CAP) pendingEvents.splice(0, pendingEvents.length - QUEUE_CAP);
    },
    appendLog: (serverId, line) => {
      pendingLogs.push({ at: new Date().toISOString(), serverId, line });
      if (pendingLogs.length > QUEUE_CAP) pendingLogs.splice(0, pendingLogs.length - QUEUE_CAP);
    },

    flush: (snapshot) => {
      const events = pendingEvents;
      const logs = pendingLogs;
      pendingEvents = [];
      pendingLogs = [];
      try {
        db.exec('BEGIN');
        for (const e of events) {
          insEvent.run(e.at, e.serverId, e.server, e.tool, e.client, e.ok ? 1 : 0, e.ms, e.bytesIn, e.bytesOut, e.error ?? null);
        }
        for (const l of logs) insLog.run(l.at, l.serverId, l.line);
        writeAggregates(snapshot);
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        // Put the rows back so the next flush retries them (bounded by QUEUE_CAP).
        pendingEvents = [...events, ...pendingEvents];
        pendingLogs = [...logs, ...pendingLogs];
      }
    },

    loadSnapshot: (eventTail) => {
      try {
        const totals = (db.prepare('SELECT calls, errors, bytes_in, bytes_out FROM totals WHERE id = 1').get() ?? {
          calls: 0,
          errors: 0,
          bytes_in: 0,
          bytes_out: 0,
        }) as { calls: number; errors: number; bytes_in: number; bytes_out: number };

        const serverRows = db
          .prepare('SELECT server_id, name, calls, errors, bytes_in, bytes_out, total_ms, last_used FROM agg_servers')
          .all() as {
          server_id: string;
          name: string;
          calls: number;
          errors: number;
          bytes_in: number;
          bytes_out: number;
          total_ms: number;
          last_used: string | null;
        }[];
        const toolRows = db.prepare('SELECT server_id, tool, calls, errors, total_ms FROM agg_tools').all() as {
          server_id: string;
          tool: string;
          calls: number;
          errors: number;
          total_ms: number;
        }[];
        const scRows = db.prepare('SELECT server_id, client FROM agg_server_clients').all() as {
          server_id: string;
          client: string;
        }[];
        const clientRows = db
          .prepare('SELECT client, calls, errors, bytes_in, bytes_out, last_used FROM agg_clients')
          .all() as { client: string; calls: number; errors: number; bytes_in: number; bytes_out: number; last_used: string }[];

        // Newest `eventTail` rows, returned oldest-first to match the supervisor's ring order.
        const eventRows = db
          .prepare(
            `SELECT at, server_id, server, tool, client, ok, ms, bytes_in, bytes_out, error
             FROM usage_events ORDER BY id DESC LIMIT ?`,
          )
          .all(eventTail) as EventRow[];

        const nothingStored =
          totals.calls === 0 && serverRows.length === 0 && clientRows.length === 0 && eventRows.length === 0;
        if (nothingStored) return undefined;

        return {
          since: getMeta('since') ?? new Date().toISOString(),
          totals: { calls: totals.calls, errors: totals.errors, bytesIn: totals.bytes_in, bytesOut: totals.bytes_out },
          events: eventRows.reverse().map(rowToEvent),
          servers: serverRows.map((s) => ({
            serverId: s.server_id,
            name: s.name,
            calls: s.calls,
            errors: s.errors,
            bytesIn: s.bytes_in,
            bytesOut: s.bytes_out,
            totalMs: s.total_ms,
            lastUsed: s.last_used ?? undefined,
            clients: scRows.filter((r) => r.server_id === s.server_id).map((r) => r.client),
            tools: toolRows
              .filter((r) => r.server_id === s.server_id)
              .map((r) => ({ tool: r.tool, calls: r.calls, errors: r.errors, totalMs: r.total_ms })),
          })),
          clients: clientRows.map((c) => ({
            client: c.client,
            calls: c.calls,
            errors: c.errors,
            bytesIn: c.bytes_in,
            bytesOut: c.bytes_out,
            lastUsed: c.last_used,
          })),
        };
      } catch {
        return undefined;
      }
    },

    events: ({ limit = 100, serverId, client, since }) => {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (serverId) {
        where.push('server_id = ?');
        args.push(serverId);
      }
      if (client) {
        where.push('client = ?');
        args.push(client);
      }
      if (since) {
        where.push('at >= ?');
        args.push(since);
      }
      const sql = `SELECT at, server_id, server, tool, client, ok, ms, bytes_in, bytes_out, error FROM usage_events
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY id DESC LIMIT ?`;
      args.push(Math.min(5000, Math.max(1, limit)));
      try {
        return (db.prepare(sql).all(...args) as EventRow[]).map(rowToEvent);
      } catch {
        return [];
      }
    },

    logs: (serverId, limit = 500) => {
      try {
        const rows = db
          .prepare('SELECT at, server_id, line FROM server_logs WHERE server_id = ? ORDER BY id DESC LIMIT ?')
          .all(serverId, Math.min(10_000, Math.max(1, limit))) as { at: string; server_id: string; line: string }[];
        return rows.reverse().map((r) => ({ at: r.at, serverId: r.server_id, line: r.line }));
      } catch {
        return [];
      }
    },

    hourlySeries: (hours) => {
      const HOUR = 3_600_000;
      const base = Math.floor(Date.now() / HOUR) * HOUR;
      const startMs = base - (hours - 1) * HOUR;
      const counts = new Map<string, number>();
      try {
        // strftime buckets to the hour; SQLite compares ISO-8601 strings correctly.
        const rows = db
          .prepare(
            `SELECT strftime('%Y-%m-%dT%H', at) AS hour, COUNT(*) AS calls
             FROM usage_events WHERE at >= ? GROUP BY hour`,
          )
          .all(new Date(startMs).toISOString()) as { hour: string; calls: number }[];
        for (const r of rows) counts.set(r.hour, r.calls);
      } catch {
        /* fall through to zeros */
      }
      return Array.from({ length: hours }, (_, i) => {
        const t = new Date(startMs + i * HOUR);
        return { t: t.toISOString(), calls: counts.get(t.toISOString().slice(0, 13)) ?? 0 };
      });
    },

    prune: () => {
      const eventDays = retainDays('HYPERGATE_RETAIN_USAGE_DAYS', 90);
      const logDays = retainDays('HYPERGATE_RETAIN_LOG_DAYS', 14);
      const cutoff = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
      try {
        db.exec('BEGIN');
        if (eventDays > 0) db.prepare('DELETE FROM usage_events WHERE at < ?').run(cutoff(eventDays));
        if (logDays > 0) db.prepare('DELETE FROM server_logs WHERE at < ?').run(cutoff(logDays));
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
      }
    },

    close: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };

  importLegacyJson();
  return store;
};

// ── row mapping ─────────────────────────────────────────────────────────────
interface EventRow {
  at: string;
  server_id: string;
  server: string;
  tool: string;
  client: string;
  ok: number;
  ms: number;
  bytes_in: number;
  bytes_out: number;
  error: string | null;
}
const rowToEvent = (r: EventRow): UsageEvent => ({
  at: r.at,
  serverId: r.server_id,
  server: r.server,
  tool: r.tool,
  client: r.client,
  ok: r.ok === 1,
  ms: r.ms,
  bytesIn: r.bytes_in,
  bytesOut: r.bytes_out,
  error: r.error ?? undefined,
});

// Minimal structural type for the bits of `node:sqlite` we use, so this file
// compiles on a toolchain whose @types/node predates the module.
interface SqliteStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}
interface SqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}
