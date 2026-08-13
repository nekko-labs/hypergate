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
 * (no child process); its credential is supplied by the selected remote auth mode.
 */
export type RuntimeKind = 'process' | 'docker' | 'remote';

/** Transport for a `remote` server. Streamable HTTP (default) or legacy SSE. */
export type RemoteTransport = 'http' | 'sse';

/**
 * How a `remote` server authenticates. `token` is a bearer credential the user
 * pastes (e.g. a GitHub PAT), sent as `Authorization: Bearer`.
 */
export type RemoteAuth = 'oauth' | 'token' | 'none';

/** One way to connect to a catalog server that offers multiple configurations. */
export interface RegistryConnection {
  id: string;
  label: string;
  description?: string;
  runtime: RuntimeKind;
  command?: string;
  args?: string[];
  image?: string;
  url?: string;
  transport?: RemoteTransport;
  auth?: RemoteAuth;
  clientId?: string;
  scope?: string;
  tokenLabel?: string;
  tokenUrl?: string;
  requires?: string[];
  note?: string;
  /** Set when this connection's OAuth needs an app registered once (no dynamic registration). */
  oauthApp?: OAuthAppRequirement;
}

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

/**
 * Who a signed-in remote server is signed in *as*.
 *
 * A remote MCP server is reached with one account's grant, and which account
 * that is decides what the agent can see — so it belongs on the server row next
 * to the state, not buried in a token blob. Derived locally from the grant's own
 * claims (an `id_token`, or a JWT access token) and, only when those carry no
 * identity, from the provider's OpenID `userinfo` endpoint.
 *
 * Never includes the token itself.
 */
export interface ServerAccount {
  /** What to show: an email, a username, or (last resort) the subject id. */
  label: string;
  email?: string;
  /** Human display name, when the claims carry one. */
  name?: string;
  /** Stable account id (`sub`), when known. */
  subject?: string;
  /** Organisation / tenant / workspace the grant is scoped to, when named. */
  org?: string;
  /** Where the identity came from, so the UI can be honest about it. */
  source: 'id_token' | 'access_token' | 'userinfo';
}

/** Runtime status the API/UI shows. Never includes secrets. */
export interface ServerStatus {
  id: string;
  name: string;
  runtime: RuntimeKind;
  /** Effective remote authentication mode; omitted for local runtimes. */
  auth?: RemoteAuth;
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
  /**
   * The most recent line this server wrote, for the collapsed row.
   *
   * A running server's log is the one thing a list can't summarise with a pill:
   * "ready" and "ready but complaining every second" look identical. Carrying
   * the last line on the status the UI already polls means the list can show it
   * without a request per row. Absent for a server that has said nothing (a
   * remote one never does: it has no stderr).
   */
  lastLog?: string;
  startedAt?: string;
  restarts: number;
  /** Remote endpoint (remote runtime), surfaced for display. */
  url?: string;
  /**
   * Browser authorization URL to open when `state === 'authorizing'`. Present
   * only transiently, right after an OAuth flow is (re)started for this server.
   */
  authUrl?: string;
  /**
   * The account this server's stored grant belongs to (remote + OAuth only).
   * Absent when the server needs no login, isn't signed in, or the provider
   * gave us nothing to identify the account with.
   */
  account?: ServerAccount;
  /**
   * This server holds a live OAuth grant. Distinguishes "signed in, but the
   * provider won't say as whom" from "no sign-in involved at all", which
   * `account` alone cannot.
   */
  signedIn?: boolean;
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
  /** How a remote entry authenticates; `oauth` drives browser login, `token` prompts for a bearer credential. */
  auth?: RemoteAuth;
  /** Pre-registered OAuth client id, for providers without dynamic registration. */
  clientId?: string;
  /** Optional OAuth scope to request. */
  scope?: string;
  /** Label for the credential prompt when `auth` is `token`. */
  tokenLabel?: string;
  /** Where the user can create the credential when `auth` is `token`. */
  tokenUrl?: string;
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
  /**
   * This provider registers no OAuth clients for itself, so browser sign-in needs
   * an app registered once — by the packager (env / `clientId`) or by the user, in
   * the app. Its presence is what lets the UI offer that setup instead of failing.
   */
  oauthApp?: OAuthAppRequirement;
  /** Alternative connection configurations for this logical server. */
  connections?: RegistryConnection[];
  /**
   * Whether this is the approach the provider itself recommends, stated in one
   * sentence under the row. Computed by the daemon (see `@hypergate/core`'s
   * `adviceForServer`) so the same verdict backs the UI and the CLI.
   */
  advice?: Advice;
}

/**
 * A provider with no dynamic client registration: browser sign-in needs an OAuth
 * app registered once, either by whoever packaged Hypergate (env/catalog) or by
 * the user in the app. Present on an entry, it tells the UI it can offer that
 * setup instead of failing the add.
 */
export interface OAuthAppRequirement {
  /** The provider's "register a new OAuth app" page. */
  registerUrl: string;
  /** True when the provider also demands client authentication at the token endpoint (GitHub does, even with PKCE). */
  secretRequired?: boolean;
  /** Provider documentation for the registration, when it has a dedicated page. */
  docsUrl?: string;
  /** What to put in the app's name/description fields, when the provider is fussy. */
  hint?: string;
}

/** Whether a configured OAuth app exists for a provider, and where it came from. */
export interface OAuthAppInfo {
  serverId: string;
  configured: boolean;
  /** `config` = in servers.json, `env` = HYPERGATE_CLIENTID_*, `keychain` = set up in the app. */
  source?: 'config' | 'env' | 'keychain';
  /** First and last few characters only — enough to recognise, never the whole id. */
  clientIdHint?: string;
  /** Whether a client secret is stored alongside it. */
  hasSecret?: boolean;
  /** The exact redirect URI this daemon will use, for pasting into the provider's form. */
  redirectUri: string;
  /** Where credentials would be stored if saved now. */
  storage: 'keychain' | 'file';
  requirement?: OAuthAppRequirement;
}

/**
 * "Is this the right thing to install?" — the one-sentence verdict shown directly
 * under a search result, and the whole point of the search being trustworthy:
 *
 * - `official` — published by the vendor it claims to be from. Go ahead.
 * - `recommended` — official *and* the approach that vendor points agents at.
 * - `verified` — we know who published it, but not that they are the service's
 *   own vendor (a domain-verified third-party wrapper).
 * - `superseded` — real, but the provider now recommends something else (`prefer`).
 * - `deprecated` — the maintainer has marked it deprecated, in their own words.
 * - `community` — a third-party implementation of someone else's service.
 * - `unverified` — nothing about the publisher could be established.
 */
export type AdviceKind = 'recommended' | 'official' | 'verified' | 'superseded' | 'deprecated' | 'community' | 'unverified';

/** What to use instead, when this result isn't the recommended path. */
export interface AdvicePreference {
  name: string;
  /** A curated catalog id, when the alternative is something Hypergate ships. */
  entryId?: string;
  /** Which catalog the alternative lives in. */
  kind?: 'mcp' | 'cli';
  /** A ready-to-run install command, for a CLI alternative. */
  install?: string;
  /** Docs for the alternative. */
  url?: string;
}

export interface Advice {
  kind: AdviceKind;
  /** One sentence, written for the person deciding whether to click Add. */
  message: string;
  prefer?: AdvicePreference;
}

const registryConnectionFields = [
  'runtime', 'command', 'args', 'image', 'url', 'transport', 'auth', 'clientId',
  'scope', 'tokenLabel', 'tokenUrl', 'requires', 'note', 'oauthApp',
] as const;

/** Return the available connection options, including a synthesized default. */
export function registryConnections(entry: RegistryEntry): RegistryConnection[] {
  if (entry.connections?.length) return entry.connections;
  const option = Object.fromEntries(
    registryConnectionFields
      .filter((field) => entry[field] !== undefined)
      .map((field) => [field, entry[field]]),
  ) as Omit<RegistryConnection, 'id' | 'label'>;
  return [{ id: 'default', label: 'Default', ...option }];
}

/** Resolve a connection choice into the existing RegistryEntry-shaped config. */
export function resolveRegistryConnection(entry: RegistryEntry, connectionId?: string): RegistryEntry {
  const options = registryConnections(entry);
  const connection = options.find((option) => option.id === connectionId) ?? options[0];
  if (!connection) return entry;
  const resolved = { ...entry };
  if (entry.connections?.length) {
    for (const field of registryConnectionFields) {
      delete (resolved as Record<string, unknown>)[field];
    }
  }
  for (const field of registryConnectionFields) {
    const value = field === 'command' && connection.command === undefined ? '' : connection[field];
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[field] = value;
    }
  }
  delete resolved.connections;
  return resolved;
}

export function mergeCatalogSearch(curated: RegistryEntry[], searched: RegistryEntry[], query: string): RegistryEntry[] {
  const needle = query.trim().toLowerCase();
  const matchingCurated = needle
    ? curated.filter((entry) => [entry.name, entry.id, entry.description, entry.homepage].some((value) => value?.toLowerCase().includes(needle)))
    : [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  return [...matchingCurated, ...searched].filter((entry) => {
    const url = entry.url?.toLowerCase().replace(/\/+$/, '');
    if (ids.has(entry.id) || (url && urls.has(url))) return false;
    ids.add(entry.id);
    if (url) urls.add(url);
    return true;
  });
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
  /** First-party tool from the vendor it says it's from (hand-set on curated entries, derived on looked-up ones). */
  official?: boolean;
  /** In Hypergate's recommended set for agent work — sorts first, gets a ★. */
  recommended?: boolean;
  /** Who publishes it: an npm scope/owner, a Homebrew tap, or a vendor name. */
  publisher?: string;
}

/** Which catalog an installable CLI was found in. */
export type CliChannel = 'curated' | 'npm' | 'brew';

/** One way to install a tool, ready to copy. `platforms` limits where it applies. */
export interface CliInstallOption {
  /** How it's obtained: `npm`, `Homebrew`, `winget`, `download`… */
  label: string;
  /** The exact command to run, or a URL when there is no command. */
  command: string;
  platforms?: string[];
}

/**
 * A command-line tool you could install — the CLI equivalent of a catalog
 * entry. Curated ones ship with Hypergate; the rest come from a lookup against
 * the npm registry or Homebrew's formulae API when the user searches (see
 * SPEC §3.3, and `cli-search.ts` for why those two are the authoritative
 * sources). Never fetched on boot.
 */
export interface CliCatalogEntry extends CliTool {
  channel: CliChannel;
  /** The package/formula id in its channel (`@playwright/cli`, `jq`). */
  package?: string;
  /** Latest published version, when the channel states one. */
  latest?: string;
  /** Popularity in its own channel: npm downloads/month, or Homebrew 30-day installs. */
  popularity?: number;
  /** The maintainer's own deprecation notice, verbatim. */
  deprecated?: string;
  /** Install routes, best-first for the machine that asked. */
  installs?: CliInstallOption[];
  /** Whether the command was on PATH when this result was assembled. */
  installed?: boolean;
  /** Version found on PATH, when installed. */
  version?: string;
  /** Absolute path on PATH, when installed. */
  path?: string;
  advice?: Advice;
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
  /**
   * The known harness this agent *is* (a {@link ConnectTarget} id), when it was
   * created from the catalog rather than by hand.
   *
   * This is what makes an agent "official": its name is the product's name, so
   * it is not the user's to rename, and it has exactly one way to be connected
   * — the client's own. A custom agent has no target: the user named it, and
   * picks a client when they connect it.
   */
  target?: string;
}

/** Request body to create an agent. */
export interface CreateAgentRequest {
  name: string;
  servers: '*' | string[];
  /** Known harness this agent is for (a {@link ConnectTarget} id), if any. */
  target?: string;
}

/** Request body to update an agent (partial). */
export interface UpdateAgentRequest {
  name?: string;
  servers?: '*' | string[];
}

/**
 * Request body to enable or disable one server for one agent
 * (`POST /api/clients/:id/servers/:serverId`).
 *
 * A single-server flip rather than a whole allow-list write: the daemon knows
 * every configured server, so it can turn a `'*'` scope into the explicit list
 * it implies before removing one, something a UI holding a stale server list
 * cannot do safely.
 */
export interface SetAgentServerRequest {
  allowed: boolean;
}

/** Rotate an existing agent's bearer token without changing its scope. */
export interface RotateAgentTokenResponse extends AgentClientInfo {}

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
 * Connecting an agent harness to the gateway.
 *
 * Every connection is one scoped agent token pointed at one client, so this all
 * hangs off a connected agent rather than off the master token. A `cli` target
 * we can wire up ourselves — the daemon runs the client's own `mcp add` command,
 * shell-free, with an argv it built; a `config` target gets a snippet plus the
 * path of the file to paste it into. Either way the UI also shows the exact
 * command, quoted for the user's shell, so nothing is hidden behind the button.
 */

/** Shell whose quoting rules a copy-paste connect command should follow. */
export type ConnectShell = 'powershell' | 'cmd' | 'bash';

/**
 * How a client gets connected: run its CLI, paste a config snippet, add the
 * endpoint by hand in the client's own settings (`manual` — a cloud agent or an
 * app whose MCP list lives in a UI, not a file we can name), or hand the whole
 * job to the client itself over a URL scheme it registered (`deeplink`).
 *
 * `deeplink` is the best of the four when a client offers it: the app comes
 * forward, applies the entry to its own live state, and confirms with the
 * user. No file to write behind a running app's back, no CLI to have installed.
 */
export type ConnectMethod = 'cli' | 'config' | 'manual' | 'deeplink';

/** An agent harness the gateway can be connected to. Pure data. */
export interface ConnectTarget {
  id: string;
  name: string;
  method: ConnectMethod;
  /** The executable to look for on PATH (`cli` targets). */
  command?: string;
  /** One-line description shown under the client's name. */
  hint?: string;
  homepage?: string;
  /** How to install the CLI, shown when it isn't on PATH (`cli` targets). */
  install?: string;
  /** What this agent *is*, one line, for the "add an agent" picker. */
  blurb?: string;
  /** A caveat worth stating up front (e.g. a cloud agent that can't see localhost). */
  note?: string;
}

/** A target plus what this machine actually has. */
export interface ConnectTargetStatus extends ConnectTarget {
  /** `cli`: the command is on PATH. `config`/`manual`: always true (nothing to detect). */
  found: boolean;
  /** Version of the detected CLI, best-effort. */
  version?: string;
  /** Where this client keeps its MCP config, resolved for this OS, when it is a file. */
  configPath?: string;
}

/** The detected clients on this machine, plus the shell to preselect. */
export interface ConnectTargetsInfo {
  platform: string;
  defaultShell: ConnectShell;
  shells: ConnectShell[];
  targets: ConnectTargetStatus[];
}

/** A target with the connect material filled in for one agent's token. */
export interface AgentConnectTarget extends ConnectTargetStatus {
  /** The argv the daemon runs on one click (`cli` targets). */
  argv?: string[];
  /** The same command quoted per shell, for users who'd rather run it themselves. */
  commands?: Record<ConnectShell, string>;
  /**
   * Config-file snippet to paste. Present for `config` targets, and also for a
   * `cli` target whose config format we know — so someone without the CLI
   * installed still has a way in rather than a dead end.
   */
  snippet?: string;
  /** The bearer token to paste into a `manual` client's settings form. */
  token?: string;
  /**
   * The URL that asks the client to connect itself (`deeplink` targets).
   *
   * It names this gateway and nothing else, with no token riding along. The
   * client reads what it needs back over loopback and asks its own user first,
   * which is what keeps a URL (something any program can open) from being an
   * instruction anyone can give.
   */
  deepLink?: string;
}

/** `GET /api/clients/:id/connect` — everything needed to connect one agent. */
export interface AgentConnectInfo extends ConnectTargetsInfo {
  agentId: string;
  /** The MCP entry name the client ends up with (constant, so re-connecting replaces it). */
  entryName: string;
  url: string;
  /** The agent's own harness, when it has one — the only target worth showing. */
  target?: string;
  targets: AgentConnectTarget[];
}

/** `POST /api/clients/:id/connect` — run a `cli` target's install for the user. */
export interface ConnectRequest {
  /** Id of the `cli` target to connect (see ConnectTarget.id). */
  target: string;
}

/** Outcome of a one-click connect. */
export interface ConnectResult {
  ok: boolean;
  target: string;
  /** The command that ran, as a display string. */
  command: string;
  /** Combined stdout/stderr from the client's CLI, trimmed. */
  output: string;
  /** Why it failed, when it did. */
  error?: string;
}

/**
 * What the manager window's close button does.
 *
 * `tray` keeps Hypergate resident (the window goes away, the gateway and every
 * managed server stay up); `quit` takes the whole thing down. `ask` is the
 * first-run state: the shell shows the choice in the window the first time it is
 * closed and records the answer here, because guessing wrong either kills a
 * user's running servers or leaves them running when they meant to stop.
 */
export type CloseAction = 'ask' | 'tray' | 'quit';

/**
 * Desktop/service preferences for the local daemon. Persisted in
 * `~/.hypergate/settings.json`. `runOnStartup` is backed by a real OS autostart
 * entry (Windows: an HKCU `…\Run` value; macOS: a LaunchAgent; Linux: an XDG
 * autostart entry); `startMinimized` is read by the tray launcher to decide
 * whether to open the manager UI on launch or just sit in the notification area.
 */
export interface DaemonSettings {
  /** Launch Hypergate automatically when the user signs in. */
  runOnStartup: boolean;
  /** Stay in the tray on launch instead of opening the manager UI. */
  startMinimized: boolean;
  /** What the manager window's close button does. Defaults to `ask` (first run). */
  closeAction: CloseAction;
  /**
   * A version the user pressed Skip on. It stays available in Settings and a
   * forced check clears it: skipping means "stop offering this one", not
   * "never update again".
   */
  skippedUpdate?: string;
}

/** `/api/settings` payload: the settings plus what this platform can actually do. */
export interface SettingsInfo extends DaemonSettings {
  /** Host platform, e.g. `win32` / `darwin` / `linux`. */
  platform: string;
  /** Whether OS autostart integration works on this platform. */
  startupSupported: boolean;
  /**
   * How the login item is (or would be) installed: `shell` = delegated to the
   * `hypergate` binary, `daemon` = written by the daemon itself, `none` = not
   * available here. Surfaced so the UI can say what it will actually launch.
   */
  startupVia: 'shell' | 'daemon' | 'none';
  /** The command the login item runs, when autostart is available. */
  startupCommand?: string;
}

/** Request body to update settings (partial). */
export interface UpdateSettingsRequest {
  runOnStartup?: boolean;
  startMinimized?: boolean;
  closeAction?: CloseAction;
  /** A version to stop being offered, or `null` to start being offered it again. */
  skippedUpdate?: string | null;
}

/**
 * Updates.
 *
 * How this install got here decides what an update can do to it, so the channel
 * is detected rather than assumed. `npm` is a global npm install (the published
 * `hypergated` package plus its platform shell binary); `installer` is one of the
 * native packages (.exe / .dmg / .deb / .rpm / tarball); `repo` is a checkout
 * being run in place; `unknown` is anything we cannot place, where we tell the
 * user what we found instead of guessing at a command.
 */
export type InstallChannel = 'npm' | 'installer' | 'repo' | 'unknown';

/** What an update would take on this install (from `updatePlan`). */
export interface UpdatePlan {
  /** Can Hypergate apply the update itself, in one click? */
  canApply: boolean;
  /** The equivalent command, always shown so the button is never a black box. */
  command?: string;
  /** Why it can't be applied for you, when it can't. */
  note?: string;
}

/**
 * `GET /api/update` (cached, never fetches) and `POST /api/update/check` (fetches).
 *
 * `latest` is absent until a check has found a published release: with nothing
 * published yet that is the honest answer, not an error.
 */
export interface UpdateInfo extends UpdatePlan {
  /** The running daemon's version. */
  current: string;
  /** Newest published version, when a check has found one. */
  latest?: string;
  /** True only when `latest` is a genuinely newer version than `current`. */
  updateAvailable: boolean;
  /** When the last successful check happened (ISO), if ever. */
  checkedAt?: string;
  /** Where `latest` came from. */
  source?: 'npm' | 'github';
  /** Release notes for `latest`, when known. */
  releaseUrl?: string;
  channel: InstallChannel;
  /** Set when the last check could not reach a feed, so the UI can say why. */
  error?: string;
  /** A version already downloaded and sitting ready to install. */
  staged?: string;
  /** The version the user pressed Skip on (see `DaemonSettings.skippedUpdate`). */
  skipped?: string;
  /** Bytes the download will pull, when the feed says how big the payload is. */
  downloadSize?: number;
  /**
   * Whether the payload can be fetched here, i.e. the feed named the packages
   * to download. `canApply` says the channel *may* be replaced in place;
   * this says we know *what* to replace it with.
   */
  canDownload?: boolean;
}

/** `POST /api/update/apply`: the update was handed to the shell, which restarts Hypergate. */
export interface ApplyUpdateResponse {
  ok: boolean;
  /** The command the updater will run, echoed back for the UI's progress copy. */
  command?: string;
  error?: string;
}

/**
 * One file the update is made of: the daemon package, plus the native shell
 * build for this platform. Resolved from whichever feed answered (an npm
 * packument's `dist`, or a GitHub release's assets).
 */
export interface UpdateAsset {
  /** File name it is stored under in the staging directory. */
  name: string;
  url: string;
  /** Bytes, when the feed says. */
  size?: number;
  /** npm's `dist.integrity` (`sha512-…`), checked after download when present. */
  integrity?: string;
  /** npm's `dist.shasum` (sha1 hex), the older integrity field. */
  shasum?: string;
  /** GitHub release SHA256SUMS entry, required for GitHub-sourced assets. */
  sha256?: string;
  /** Feed that supplied this asset; GitHub assets require sha256. */
  source?: 'npm' | 'github';
}

/**
 * How far along a download or install is.
 *
 * `downloading` is real: bytes received out of the payload size. `installing`
 * cannot be, because the install replaces the files the daemon is running from,
 * so the daemon is gone for the duration — the UI shows the phase and waits for
 * the new version to answer.
 */
export type UpdateStage = 'idle' | 'downloading' | 'staged' | 'installing' | 'error';

export interface UpdateProgress {
  stage: UpdateStage;
  /** The version being downloaded or installed. */
  version?: string;
  received: number;
  /** Total bytes, when every asset declared a size. */
  total?: number;
  /** 0..1, only when `total` is known. */
  fraction?: number;
  /** Which file is in flight, so a two-file download can say so. */
  file?: string;
  error?: string;
  startedAt?: string;
}

/**
 * What the last completed update did, written by the updater and read once by
 * the UI that comes back up. Without it a successful update is indistinguishable
 * from a crash-and-restart.
 */
export interface UpdateResult {
  ok: boolean;
  /** The version that was installed (or attempted). */
  version: string;
  finishedAt: string;
  error?: string;
}

/**
 * Answer to `POST /api/shutdown`: the daemon accepted the request and will exit
 * once this response is on the wire. `servers` is how many managed servers it
 * stops on the way out, so the UI can say what actually went down.
 */
export interface ShutdownResponse {
  ok: boolean;
  /** Managed servers the daemon is stopping before it exits. */
  servers: number;
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
