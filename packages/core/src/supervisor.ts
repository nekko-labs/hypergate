import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  AnalyticsSnapshot,
  AnalyticsSummary,
  ClientUsage,
  ManagedServerConfig,
  ServerState,
  ServerStatus,
  ServerUsage,
  ToolInfo,
  UsageEvent,
} from '@hypergate/shared';
import { runtimeFor } from './runtime.js';

/** Builds the OAuth provider for a remote server, or undefined when none is needed. */
export type AuthProviderFor = (config: ManagedServerConfig) => OAuthClientProvider | undefined;
/** Supplies headers for a remote server without making core responsible for secret storage. */
export type AuthHeadersFor = (config: ManagedServerConfig) => Record<string, string> | undefined;

const LOG_CAP = 500;
/** Cap on the retained event feed (for the recent-calls feed + time series). */
const EVENT_CAP = 2000;

interface ToolAgg {
  calls: number;
  errors: number;
  totalMs: number;
}
interface ServerAgg {
  name: string;
  calls: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  totalMs: number;
  lastUsed?: string;
  tools: Map<string, ToolAgg>;
  clients: Set<string>;
}
interface ClientAgg {
  calls: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  lastUsed: string;
}

interface Instance {
  config: ManagedServerConfig;
  client?: Client;
  transport?: Transport;
  state: ServerState;
  tools: ToolInfo[];
  error?: string;
  startedAt?: string;
  restarts: number;
  logs: string[];
}

const toStatus = (i: Instance): ServerStatus => ({
  id: i.config.id,
  name: i.config.name,
  runtime: i.config.runtime,
  auth: i.config.runtime === 'remote' ? i.config.auth : undefined,
  state: i.state,
  tools: i.tools.map((t) => t.name),
  toolDetails: i.tools,
  error: i.error,
  startedAt: i.startedAt,
  restarts: i.restarts,
  url: i.config.url,
  lastLog: i.logs[i.logs.length - 1],
});

/** Heuristic: does this connect error look like an auth challenge (401/unauthorized)? */
const is401 = (e: unknown): boolean => {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('401') || msg.includes('unauthorized');
};


/**
 * Supervises managed MCP servers: launches each through its RuntimeAdapter,
 * connects an MCP client to it, tracks lifecycle state + tools + stderr logs,
 * and exposes the connected clients to the gateway. Secrets are passed to the
 * child at launch and never stored in status or logs.
 */
export class Supervisor {
  private instances = new Map<string, Instance>();

  // ── usage analytics ────────────────────────────────────────────────────
  // Aggregates persist for the daemon's lifetime; the event feed is a capped
  // ring buffer (older calls roll off the feed but stay counted in aggregates).
  // The daemon can persist/restore all of this via snapshot()/hydrate().
  private since = new Date().toISOString();
  private events: UsageEvent[] = [];
  private byServer = new Map<string, ServerAgg>();
  private byClient = new Map<string, ClientAgg>();
  private totals = { calls: 0, errors: 0, bytesIn: 0, bytesOut: 0 };
  /**
   * Called after every recorded call so the host can persist analytics. Receives
   * the event so the host can append it to durable storage; hosts that only need
   * a "something changed" nudge can ignore the argument.
   */
  private onUsage?: (e: UsageEvent) => void;
  /** Called for every server log line so the host can persist it beyond the in-memory ring. */
  private onLog?: (serverId: string, line: string) => void;
  /** Supplies the OAuth provider for a remote server (injected by the daemon). */
  private authProviderFor?: AuthProviderFor;
  /** Supplies bearer headers for token-auth remote servers (injected by the daemon). */
  private authHeadersFor?: AuthHeadersFor;
  /** Path to the `hypergate` shell binary, used to enforce per-server resource limits. */
  private launcher?: string;

  constructor(
    opts: {
      onUsage?: (e: UsageEvent) => void;
      onLog?: (serverId: string, line: string) => void;
      authProviderFor?: AuthProviderFor;
      authHeadersFor?: AuthHeadersFor;
      launcher?: string;
    } = {},
  ) {
    this.onUsage = opts.onUsage;
    this.onLog = opts.onLog;
    this.authProviderFor = opts.authProviderFor;
    this.authHeadersFor = opts.authHeadersFor;
    this.launcher = opts.launcher;
  }

  /**
   * Buffer a log line in the instance's ring and hand it to the host for durable
   * storage. The ring stays for fast reads; the host's copy is what survives a
   * restart.
   */
  private pushLog(i: Instance, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      i.logs.push(line);
      if (i.logs.length > LOG_CAP) i.logs.shift();
      this.onLog?.(i.config.id, line);
    }
  }

  list(): ServerStatus[] {
    return [...this.instances.values()].map(toStatus);
  }
  status(id: string): ServerStatus | undefined {
    const i = this.instances.get(id);
    return i ? toStatus(i) : undefined;
  }
  logs(id: string): string[] {
    return this.instances.get(id)?.logs ?? [];
  }
  ids(): string[] {
    return [...this.instances.keys()];
  }
  /** The connected client for a ready server — used by the gateway. */
  client(id: string): Client | undefined {
    const i = this.instances.get(id);
    return i?.state === 'ready' ? i.client : undefined;
  }

  /** Record one gateway tool call for analytics. Called by the gateway. */
  record(e: UsageEvent): void {
    this.events.push(e);
    if (this.events.length > EVENT_CAP) this.events.shift();

    this.totals.calls += 1;
    this.totals.bytesIn += e.bytesIn;
    this.totals.bytesOut += e.bytesOut;
    if (!e.ok) this.totals.errors += 1;

    let s = this.byServer.get(e.serverId);
    if (!s) {
      s = { name: e.server, calls: 0, errors: 0, bytesIn: 0, bytesOut: 0, totalMs: 0, tools: new Map(), clients: new Set() };
      this.byServer.set(e.serverId, s);
    }
    s.name = e.server || s.name;
    s.calls += 1;
    s.bytesIn += e.bytesIn;
    s.bytesOut += e.bytesOut;
    s.totalMs += e.ms;
    s.lastUsed = e.at;
    s.clients.add(e.client);
    if (!e.ok) s.errors += 1;

    let t = s.tools.get(e.tool);
    if (!t) {
      t = { calls: 0, errors: 0, totalMs: 0 };
      s.tools.set(e.tool, t);
    }
    t.calls += 1;
    t.totalMs += e.ms;
    if (!e.ok) t.errors += 1;

    let c = this.byClient.get(e.client);
    if (!c) {
      c = { calls: 0, errors: 0, bytesIn: 0, bytesOut: 0, lastUsed: e.at };
      this.byClient.set(e.client, c);
    }
    c.calls += 1;
    c.bytesIn += e.bytesIn;
    c.bytesOut += e.bytesOut;
    c.lastUsed = e.at;
    if (!e.ok) c.errors += 1;

    this.onUsage?.(e);
  }

  /** Serialize analytics for persistence (Maps/Sets → arrays). */
  snapshot(): AnalyticsSnapshot {
    return {
      since: this.since,
      totals: { ...this.totals },
      events: [...this.events],
      servers: [...this.byServer.entries()].map(([serverId, s]) => ({
        serverId,
        name: s.name,
        calls: s.calls,
        errors: s.errors,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
        totalMs: s.totalMs,
        lastUsed: s.lastUsed,
        clients: [...s.clients],
        tools: [...s.tools.entries()].map(([tool, t]) => ({ tool, calls: t.calls, errors: t.errors, totalMs: t.totalMs })),
      })),
      clients: [...this.byClient.entries()].map(([client, c]) => ({
        client,
        calls: c.calls,
        errors: c.errors,
        bytesIn: c.bytesIn,
        bytesOut: c.bytesOut,
        lastUsed: c.lastUsed,
      })),
    };
  }

  /** Restore analytics from a snapshot (on daemon boot). Tolerates partial data. */
  hydrate(snap: Partial<AnalyticsSnapshot> | undefined | null): void {
    if (!snap || typeof snap !== 'object') return;
    if (snap.since) this.since = snap.since;
    if (snap.totals)
      this.totals = {
        calls: snap.totals.calls ?? 0,
        errors: snap.totals.errors ?? 0,
        bytesIn: snap.totals.bytesIn ?? 0,
        bytesOut: snap.totals.bytesOut ?? 0,
      };
    if (Array.isArray(snap.events)) this.events = snap.events.slice(-EVENT_CAP);
    this.byServer = new Map();
    for (const s of snap.servers ?? []) {
      this.byServer.set(s.serverId, {
        name: s.name,
        calls: s.calls,
        errors: s.errors,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
        totalMs: s.totalMs,
        lastUsed: s.lastUsed,
        clients: new Set(s.clients ?? []),
        tools: new Map((s.tools ?? []).map((t) => [t.tool, { calls: t.calls, errors: t.errors, totalMs: t.totalMs }])),
      });
    }
    this.byClient = new Map();
    for (const c of snap.clients ?? []) {
      this.byClient.set(c.client, { calls: c.calls, errors: c.errors, bytesIn: c.bytesIn, bytesOut: c.bytesOut, lastUsed: c.lastUsed });
    }
  }

  /** Aggregated analytics for the daemon's `/api/analytics` endpoint + the UI. */
  analytics(recentCap = 50): AnalyticsSummary {
    const servers: ServerUsage[] = [...this.byServer.entries()]
      .map(([serverId, s]) => ({
        serverId,
        name: s.name,
        calls: s.calls,
        errors: s.errors,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
        avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0,
        lastUsed: s.lastUsed,
        clients: [...s.clients],
        tools: [...s.tools.entries()]
          .map(([tool, t]) => ({ tool, calls: t.calls, errors: t.errors, avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0 }))
          .sort((a, b) => b.calls - a.calls),
      }))
      .sort((a, b) => b.calls - a.calls);

    const clients: ClientUsage[] = [...this.byClient.entries()]
      .map(([client, c]) => ({ client, calls: c.calls, errors: c.errors, bytesIn: c.bytesIn, bytesOut: c.bytesOut, lastUsed: c.lastUsed }))
      .sort((a, b) => b.calls - a.calls);

    const recent = this.events.slice(-recentCap).reverse();

    // 24 hourly buckets ending at the current hour (idx 23 = this hour = "now").
    const HOUR = 3_600_000;
    const base = Math.floor(Date.now() / HOUR) * HOUR;
    const buckets = new Array(24).fill(0);
    for (const e of this.events) {
      const eventHour = Math.floor(new Date(e.at).getTime() / HOUR) * HOUR;
      const idx = 23 - Math.round((base - eventHour) / HOUR);
      if (idx >= 0 && idx < 24) buckets[idx] += 1;
    }
    const series = buckets.map((calls, i) => ({ t: new Date(base - (23 - i) * HOUR).toISOString(), calls }));

    return {
      since: this.since,
      totalCalls: this.totals.calls,
      totalErrors: this.totals.errors,
      bytesIn: this.totals.bytesIn,
      bytesOut: this.totals.bytesOut,
      servers,
      clients,
      recent,
      series,
    };
  }

  async start(config: ManagedServerConfig): Promise<ServerStatus> {
    let inst = this.instances.get(config.id);
    if (!inst) {
      inst = { config, state: 'stopped', tools: [], restarts: 0, logs: [] };
      this.instances.set(config.id, inst);
    }
    inst.config = config;
    if (inst.state === 'ready' || inst.state === 'starting') return toStatus(inst);

    inst.state = 'starting';
    inst.error = undefined;
    try {
      const transport =
        config.runtime === 'remote' ? this.remoteTransport(config, inst) : this.stdioTransport(config, inst);
      const client = new Client({ name: 'hypergate', version: '0.1.0' }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();
      inst.client = client;
      inst.transport = transport;
      inst.tools = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      inst.state = 'ready';
      inst.startedAt = new Date().toISOString();
    } catch (e) {
      // A remote server with no (usable) OAuth token isn't a hard error — it just
      // needs the user to sign in. Surface it as `authorizing` so the UI prompts,
      // rather than a red `errored` the user has to decode.
      const needsAuth = e instanceof UnauthorizedError || (config.runtime === 'remote' && is401(e));
      inst.state = needsAuth ? 'authorizing' : 'errored';
      const detail = e instanceof Error ? e.message : String(e);
      inst.error = needsAuth && config.auth === 'token' ? `Token rejected: ${detail}` : detail;
      this.pushLog(inst, `[supervisor] ${needsAuth ? 'needs authorization' : 'start failed'}: ${inst.error}`);
    }
    return toStatus(inst);
  }

  /** Local stdio child (process/docker) — the original path. */
  private stdioTransport(config: ManagedServerConfig, inst: Instance): StdioClientTransport {
    const spec = runtimeFor(config.runtime, { launcher: this.launcher }).spawnSpec(config);
    // Say plainly whether the requested limits are actually in force. A config
    // that asks for a sandbox we cannot apply must be visible, never assumed.
    const wanted = Object.entries(config.limits ?? {}).filter(([, v]) => v);
    if (wanted.length > 0) {
      const asked = wanted.map(([k, v]) => `${k}=${v}`).join(' ');
      this.pushLog(
        inst,
        this.launcher
          ? `[supervisor] resource limits enforced via sandbox-exec (${asked})`
          : `[supervisor] WARNING: limits requested (${asked}) but the hypergate launcher was not found — starting UNSANDBOXED`,
      );
    }
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => this.pushLog(inst, d.toString()));
    return transport;
  }

  /** Hosted HTTP MCP endpoint — streamable HTTP (default) or legacy SSE, with OAuth or bearer auth. */
  private remoteTransport(config: ManagedServerConfig, inst: Instance): Transport {
    if (!config.url) throw new Error(`remote runtime needs a url for server "${config.id}"`);
    const url = new URL(config.url);
    const authProvider = config.auth === 'token' || config.auth === 'none' ? undefined : this.authProviderFor?.(config);
    const headers = config.auth === 'token' ? this.authHeadersFor?.(config) : undefined;
    this.pushLog(inst, `[supervisor] connecting remote ${url.origin}${authProvider ? ' (oauth)' : headers ? ' (token)' : ''}`);
    const requestInit = headers ? { headers } : undefined;
    return config.transport === 'sse'
      ? new SSEClientTransport(url, {
          authProvider,
          requestInit,
          eventSourceInit: headers
            ? {
                fetch: (target, init) => fetch(target, {
                  ...init,
                  headers: { ...init?.headers, ...headers },
                }),
              }
            : undefined,
        })
      : new StreamableHTTPClientTransport(url, { authProvider, requestInit });
  }

  /**
   * Seat a configured server in the roster without starting it.
   *
   * The daemon calls this for servers whose config says `enabled: false`, so a
   * server you stopped is still *there* after a restart. Without it the instance
   * map only ever held servers that had been started, and since `list()` is what
   * `/api/servers` serves, a stopped server vanished from the UI on the next boot
   * while still sitting in `servers.json` (only a hand-edit brought it back).
   *
   * Nothing is spawned or connected, and an already-seated server is left alone,
   * so this is safe to call on every boot.
   */
  register(config: ManagedServerConfig): ServerStatus {
    const existing = this.instances.get(config.id);
    if (existing) {
      existing.config = config;
      return toStatus(existing);
    }
    const inst: Instance = { config, state: 'stopped', tools: [], restarts: 0, logs: [] };
    this.instances.set(config.id, inst);
    return toStatus(inst);
  }

  /**
   * Put a remote server into `authorizing` without attempting a connection —
   * used when it has no usable OAuth token yet, so the UI can prompt sign-in
   * and the server still shows up in `list()`. No network call happens here.
   */
  markAuthorizing(config: ManagedServerConfig, error?: string): ServerStatus {
    let inst = this.instances.get(config.id);
    if (!inst) {
      inst = { config, state: 'stopped', tools: [], restarts: 0, logs: [] };
      this.instances.set(config.id, inst);
    }
    inst.config = config;
    inst.client = undefined;
    inst.transport = undefined;
    inst.tools = [];
    inst.state = 'authorizing';
    inst.error = error;
    return toStatus(inst);
  }

  async stop(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;
    try {
      await inst.client?.close();
    } catch {
      /* already gone */
    }
    inst.client = undefined;
    inst.transport = undefined;
    inst.tools = [];
    if (inst.state !== 'errored') inst.state = 'stopped';
  }

  /** Stop a server and drop it from the roster entirely (config was deleted). */
  async remove(id: string): Promise<void> {
    await this.stop(id);
    this.instances.delete(id);
  }

  async restart(config: ManagedServerConfig): Promise<ServerStatus> {
    await this.stop(config.id);
    const inst = this.instances.get(config.id);
    if (inst) inst.restarts += 1;
    return this.start(config);
  }

  async stopAll(): Promise<void> {
    for (const id of this.ids()) await this.stop(id);
  }
}
