/**
 * Hypergate shared types & contracts.
 *
 * The core insight: every isolation mode reduces to "what command do we spawn
 * over stdio." Process = the server's own command; Docker = `docker run -i …`.
 * A RuntimeAdapter turns a ManagedServerConfig into a SpawnSpec; the supervisor
 * connects an MCP client to it; the gateway aggregates all of them.
 */

/**
 * How a server runs / is isolated. `process` + `docker` are local stdio children
 * (user-selectable isolation). `remote` connects to a hosted HTTP MCP endpoint
 * (no child process); its credential is an OAuth token, not a spawned command.
 */
export type RuntimeKind = 'process' | 'docker' | 'remote';

/** Transport for a `remote` server. Streamable HTTP (default) or legacy SSE. */
export type RemoteTransport = 'http' | 'sse';

/** How a `remote` server authenticates. `oauth` = the MCP browser OAuth flow. */
export type RemoteAuth = 'oauth' | 'none';

/**
 * Lifecycle state of a managed server. `authorizing` is remote-only: the server
 * is waiting for the user to finish the browser OAuth login before it can connect.
 */
export type ServerState = 'stopped' | 'starting' | 'ready' | 'errored' | 'authorizing';

/** A server Hypergate manages. Persisted in the daemon's config. */
export interface ManagedServerConfig {
  id: string;
  name: string;
  /** Isolation/connection runtime; defaults to the install's setup choice. */
  runtime: RuntimeKind;
  /**
   * The server's launch command (process runtime) or the in-container command
   * (docker). Not used by the `remote` runtime — leave empty and set `url`.
   */
  command: string;
  args?: string[];
  /** Non-secret env passed through (allow-listed). */
  env?: Record<string, string>;
  /** Secret env injected at launch only — never logged or returned by the API. */
  secrets?: Record<string, string>;
  /** Working directory (process runtime). */
  cwd?: string;
  /** Container image (docker runtime). */
  image?: string;
  /** Remote HTTP MCP endpoint (remote runtime), e.g. `https://api.githubcopilot.com/mcp/`. */
  url?: string;
  /** Transport for a remote server; defaults to `http` (streamable HTTP). */
  transport?: RemoteTransport;
  /** How a remote server authenticates; defaults to `oauth` when a remote entry omits it. */
  auth?: RemoteAuth;
  /**
   * Pre-registered OAuth client id (public client + PKCE). Required for providers
   * that don't support dynamic client registration (e.g. GitHub); when set, the
   * OAuth flow skips registration and uses this id. Left empty for DCR providers.
   */
  clientId?: string;
  /**
   * Pre-registered OAuth client secret, for providers that require one at the token
   * endpoint even with PKCE (e.g. GitHub, which doesn't treat native apps as public
   * clients). Shipped baked-in for a shared app, so not truly confidential — PKCE +
   * the loopback callback secure the flow. Prefer supplying it via env, not config.
   */
  clientSecret?: string;
  /** Optional OAuth scope to request (space-delimited), when the provider needs it. */
  scope?: string;
  /** Resource ceilings enforced by the OS (process runtime). */
  limits?: ResourceLimits;
  /** Whether the supervisor should run it. */
  enabled: boolean;
}

/**
 * OS-enforced resource ceilings for a process-runtime server.
 *
 * Applied by the `hypergate sandbox-exec` launcher, not by Node: these need
 * Windows Job Objects and POSIX `setrlimit`, which a Node parent cannot ask for.
 * When the launcher is unavailable the server still starts, unenforced, and the
 * daemon says so in its logs rather than pretending the limits are in force.
 */
export interface ResourceLimits {
  /** Memory ceiling in MB. Windows: Job Object `JobMemoryLimit`. POSIX: `RLIMIT_AS`. */
  memMb?: number;
  /** CPU ceiling as a percentage of the machine. Windows only (POSIX needs cgroups). */
  cpuPct?: number;
  /** Max open file descriptors. POSIX only (Windows has no per-process fd table). */
  nofile?: number;
}

/** What a RuntimeAdapter produces: the concrete stdio process to launch. */
export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** A tool a server exposes, with the metadata the UI needs to detail it. */
export interface ToolInfo {
  /** Bare tool name (namespaced form is `${serverId}__${name}`). */
  name: string;
  /** Human description from the server's `tools/list`. */
  description?: string;
  /** JSON Schema for the tool's arguments (used to render its parameters). */
  inputSchema?: unknown;
}

/** Runtime status the API/UI shows. Never includes secrets. */
export interface ServerStatus {
  id: string;
  name: string;
  runtime: RuntimeKind;
  state: ServerState;
  /** Tool names exposed by this server (namespaced form is `${id}__${tool}`). */
  tools: string[];
  /**
   * Full tool metadata (name + description + input schema) for the UI's tool
   * inspector. Additive to `tools` (names) so existing consumers keep working.
   */
  toolDetails?: ToolInfo[];
  /** Last error message, if state === 'errored'. */
  error?: string;
  startedAt?: string;
  restarts: number;
  /** Remote endpoint (remote runtime), surfaced for display. */
  url?: string;
  /**
   * Browser authorization URL to open when `state === 'authorizing'`. Present
   * only transiently, right after an OAuth flow is (re)started for this server.
   */
  authUrl?: string;
}

/** A curated/known server users can add in one click. */
export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  /** Recommended runtime; the user can override. */
  runtime: RuntimeKind;
  command: string;
  args?: string[];
  image?: string;
  /** Remote HTTP MCP endpoint (remote runtime). */
  url?: string;
  /** Transport for a remote entry; defaults to `http`. */
  transport?: RemoteTransport;
  /** How a remote entry authenticates; `oauth` drives the one-click browser login. */
  auth?: RemoteAuth;
  /** Pre-registered OAuth client id, for providers without dynamic registration. */
  clientId?: string;
  /** Optional OAuth scope to request. */
  scope?: string;
  /** Names of env/secret keys the server needs (prompted on add). */
  requires?: string[];
  homepage?: string;
  /** Where this entry came from: the built-in curated list or a live registry search. */
  source?: 'curated' | 'registry';
  /** A caveat to surface in the UI (e.g. a remote-only entry that can't run locally yet). */
  note?: string;
  /** True when the entry can't be launched as a local stdio child (remote-only). */
  runnable?: boolean;
  /**
   * First-party / verified-publisher server. For curated entries this is hand-set
   * from vendor docs; for registry-search hits it's derived from a domain-verified
   * reverse-DNS namespace (see `publisher`). `false` on a curated entry marks it as
   * an explicitly community (not first-party) pick; `undefined` = unknown.
   */
  official?: boolean;
  /** In Hypergate's recommended set — sorts first and gets a ★ marker. */
  recommended?: boolean;
  /**
   * The registry namespace this entry was published under (e.g. `app.linear`,
   * `io.github.someone`). A non-`io.github.*` / non-anonymous namespace is
   * domain-verified, which is what backs `official` for registry-search hits.
   */
  publisher?: string;
  /**
   * Popularity signal used to order non-recommended entries: npm downloads/month
   * when the entry is an npm package, else GitHub stars. Filled in lazily by the
   * daemon's `/api/registry/popularity` when the catalog opens; absent until then.
   */
  popularity?: number;
}

/**
 * Popularity scores keyed by catalog entry id — npm monthly downloads when the
 * entry is an npm package, otherwise GitHub stars. Fetched lazily by the daemon
 * (npm + GitHub public APIs) only when the user opens the catalog, then cached;
 * never fetched on boot (see SPEC §1). Missing ids simply have no known score.
 */
export type PopularityMap = Record<string, number>;

/**
 * A command-line tool Hypergate knows about — usually a prerequisite for running
 * some MCP servers (e.g. `flyctl` for the Fly server, `uvx` for Python servers,
 * `docker` for the Docker runtime). The CLIs section detects which are present.
 */
export interface CliTool {
  id: string;
  /** Display name, e.g. "Docker" or "GitHub CLI". */
  name: string;
  /** The executable to look for on PATH, e.g. `docker`, `gh`, `uvx`. */
  command: string;
  description: string;
  /** Grouping for the UI: runtime · package · container · cloud · vcs · mcp · other. */
  category: string;
  homepage?: string;
  /** A short install hint (URL or one-line command). */
  install?: string;
  /** Args used to read the version; defaults to `['--version']`. */
  versionArgs?: string[];
}

/** Detection result for a known CLI: is it on PATH, where, and what version. */
export interface CliStatus extends CliTool {
  found: boolean;
  /** Parsed version string when found (best-effort). */
  version?: string;
  /** Absolute path the command resolved to on PATH, when found. */
  path?: string;
}

/** Result of an ad-hoc "is this command available?" search (any command name). */
export interface CliCheckResult {
  command: string;
  found: boolean;
  path?: string;
  version?: string;
}

/**
 * Usage analytics — a first-class perk of routing through Hypergate: local,
 * private visibility into *what* your agents actually call. Every gateway tool
 * call becomes a UsageEvent; the daemon aggregates them per server, per tool,
 * and per client. Nothing leaves the machine.
 */

/** One tool call routed through the gateway. Recorded, never leaves localhost. */
export interface UsageEvent {
  /** ISO timestamp of the call. */
  at: string;
  /** Owning server id and display name (name captured at call time). */
  serverId: string;
  server: string;
  /** Bare tool name (the un-namespaced part of `${serverId}__${tool}`). */
  tool: string;
  /** Best-effort caller identity (from the MCP handshake's clientInfo). */
  client: string;
  /** Whether the call succeeded. */
  ok: boolean;
  /** Round-trip duration in milliseconds. */
  ms: number;
  /** Bytes of arguments sent to the server. */
  bytesIn: number;
  /** Bytes of result returned from the server. */
  bytesOut: number;
  /** Error message when `ok` is false. */
  error?: string;
}

/** Per-tool rollup for a server. */
export interface ToolUsage {
  tool: string;
  calls: number;
  errors: number;
  avgMs: number;
}

/** Per-client rollup across all servers. */
export interface ClientUsage {
  client: string;
  calls: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  lastUsed: string;
}

/** Per-server usage rollup. */
export interface ServerUsage {
  serverId: string;
  name: string;
  calls: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  avgMs: number;
  lastUsed?: string;
  tools: ToolUsage[];
  /** Distinct client identities that have called this server. */
  clients: string[];
}

/** The analytics payload served at `/api/analytics`. */
export interface AnalyticsSummary {
  /** When usage tracking started (daemon start). */
  since: string;
  totalCalls: number;
  totalErrors: number;
  bytesIn: number;
  bytesOut: number;
  servers: ServerUsage[];
  clients: ClientUsage[];
  /** Most-recent-first, capped feed of individual calls. */
  recent: UsageEvent[];
  /** Hourly call-volume buckets for the last 24h (oldest → newest). */
  series: { t: string; calls: number }[];
}

/**
 * Serializable dump of the supervisor's analytics aggregates + event feed, so
 * usage survives a daemon restart. The daemon persists this to
 * `~/.hypergate/analytics.json` and re-hydrates it on boot. Maps/Sets are
 * flattened to arrays for JSON.
 */
export interface AnalyticsSnapshot {
  /** When usage tracking first started (preserved across restarts). */
  since: string;
  totals: { calls: number; errors: number; bytesIn: number; bytesOut: number };
  events: UsageEvent[];
  servers: {
    serverId: string;
    name: string;
    calls: number;
    errors: number;
    bytesIn: number;
    bytesOut: number;
    totalMs: number;
    lastUsed?: string;
    clients: string[];
    tools: { tool: string; calls: number; errors: number; totalMs: number }[];
  }[];
  clients: { client: string; calls: number; errors: number; bytesIn: number; bytesOut: number; lastUsed: string }[];
}

/**
 * A connected agent (MCP client) with its own gateway token and a per-server
 * allow-list. The master gateway token (see GatewayInfo) always has full
 * access; named agents are additional, scoped credentials so you can hand a
 * client a token that only reaches the servers it needs.
 */
export interface AgentClient {
  id: string;
  name: string;
  /** Bearer token this agent presents on the gateway. Localhost-only, like the master token. */
  token: string;
  /** Allowed servers: `'*'` = every server, or an allow-list of server ids. */
  servers: '*' | string[];
  createdAt: string;
  /** Last time a call was attributed to this agent's token. */
  lastUsed?: string;
}

/** Request body to create an agent. */
export interface CreateAgentRequest {
  name: string;
  servers: '*' | string[];
}

/** Request body to update an agent (partial). */
export interface UpdateAgentRequest {
  name?: string;
  servers?: '*' | string[];
}

/** An agent plus a ready-to-paste connect snippet (returned by the clients API). */
export interface AgentClientInfo extends AgentClient {
  /** The gateway URL this agent connects to. */
  url: string;
  /** A `claude mcp add` one-liner scoped to this agent's token. */
  connectCommand: string;
  /** A `.mcp.json` snippet using this agent's token. */
  clientSnippet: Record<string, unknown>;
}

/**
 * Desktop/service preferences for the local daemon. Persisted in
 * `~/.hypergate/settings.json`. `runOnStartup` is backed by an OS autostart
 * entry (Windows: an HKCU `…\Run` value launching the tray hidden);
 * `startMinimized` is read by the tray launcher to decide whether to open the
 * manager UI on launch or just sit in the notification area.
 */
export interface DaemonSettings {
  /** Launch Hypergate automatically when the user signs in. */
  runOnStartup: boolean;
  /** Stay in the tray on launch instead of opening the manager UI. */
  startMinimized: boolean;
}

/** `/api/settings` payload: the settings plus what this platform can actually do. */
export interface SettingsInfo extends DaemonSettings {
  /** Host platform, e.g. `win32` / `darwin` / `linux`. */
  platform: string;
  /** Whether OS autostart integration is wired up on this platform (Windows for now). */
  startupSupported: boolean;
}

/** Request body to update settings (partial). */
export interface UpdateSettingsRequest {
  runOnStartup?: boolean;
  startMinimized?: boolean;
}

/** Daemon management API (HTTP, localhost) — request/response contracts. */
export interface GatewayInfo {
  /** Streamable-HTTP MCP endpoint for URL-based clients. */
  url: string;
  /** stdio command a client can spawn for the aggregated gateway. */
  stdioCommand: string;
  /** Bearer token for the HTTP endpoint (when auth is on). */
  token?: string;
  /** A ready-to-paste `.mcp.json` snippet for the gateway (HTTP transport). */
  clientSnippet: Record<string, unknown>;
  /** A ready-to-paste `.mcp.json` snippet for the stdio gateway. */
  stdioSnippet?: Record<string, unknown>;
  /** The daemon's own web UI, served at the daemon root. */
  uiUrl?: string;
}
