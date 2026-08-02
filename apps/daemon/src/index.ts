import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, extname, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  Supervisor,
  createGateway,
  createProxy,
  agentNameFromKey,
  agentSlug,
  matchAgents,
  REGISTRY,
  searchRegistry,
  KNOWN_CLIS,
  CONNECT_TARGETS,
  ENTRY_NAME,
  agentConnectTarget,
  configPathFor,
  connectArgv,
  connectTarget,
  defaultShellFor,
  formatCommand,
  shellsFor,
  HypergateOAuthProvider,
  HYPERGATE_OAUTH_IDENTITY,
  setServerAllowed,
  assetsFromGithub,
  assetsFromNpm,
  detectInstallChannel,
  isNewerVersion,
  latestFromGithub,
  latestFromNpm,
  releaseUrlFor,
  shellPackageFor,
  updatePlan,
  GITHUB_FEED_URL,
  NPM_FEED_URL,
  accountFromTokens,
  accountFromUserinfo,
  authorizationServersOf,
  decodeJwtClaims,
  userinfoEndpoint,
  type OAuthStore,
} from '@hypergate/core';
import { openStore } from './store.ts';
import * as shell from './shell.ts';
import * as autostart from './autostart.ts';
import { Updater } from './updater.ts';
import type {
  ManagedServerConfig,
  GatewayInfo,
  AgentClient,
  AgentClientInfo,
  AnalyticsSnapshot,
  ServerStatus,
  DaemonSettings,
  SettingsInfo,
  UpdateSettingsRequest,
  RegistryEntry,
  PopularityMap,
  CliStatus,
  CliCheckResult,
  ConnectTargetStatus,
  ConnectTargetsInfo,
  AgentConnectInfo,
  ConnectResult,
  SetAgentServerRequest,
  ShutdownResponse,
  UpdateInfo,
  UpdateAsset,
  ApplyUpdateResponse,
  InstallChannel,
  ServerAccount,
} from '@hypergate/shared';

/**
 * hypergated — the Hypergate daemon. Two modes:
 *   • default: one localhost port serving the management API, the web UI, and
 *     the streamable-HTTP MCP gateway at /mcp (bearer-token auth).
 *   • `--stdio`: connect the aggregating gateway to stdio so an agent harness
 *     (Claude Code, Cursor, Nekkos) can spawn `hypergated --stdio` as ONE
 *     MCP endpoint that fans out to all enabled servers.
 *
 * Local-first: binds to localhost. The daemon makes outbound calls only for
 * user-initiated actions — registry search, and connecting to the remote MCP
 * servers a user adds (plus their OAuth login/token exchange). OAuth tokens are
 * stored in the OS keychain (via the `hypergate` shell binary), falling back to
 * ~/.hypergate/oauth/ where no keychain exists. Nothing phones home on its own.
 *
 * Durable state (usage history, server logs) lives in SQLite at
 * ~/.hypergate/hypergate.db — see store.ts.
 */
const DATA_DIR = process.env.HYPERGATE_DIR ?? join(homedir(), '.hypergate');
// One-time migration from the pre-rename data dir (NekkoMCP → Hypergate, v0.7.0):
// adopt ~/.nekko-mcp wholesale so servers, tokens, analytics, and OAuth grants survive.
if (!process.env.HYPERGATE_DIR && !existsSync(DATA_DIR)) {
  const legacyDir = join(homedir(), '.nekko-mcp');
  if (existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, DATA_DIR);
    } catch {
      /* cross-device or locked: fall through and start fresh */
    }
  }
}
const CONFIG_PATH = join(DATA_DIR, 'servers.json');
const TOKEN_PATH = join(DATA_DIR, 'gateway-token');
const ANALYTICS_PATH = join(DATA_DIR, 'analytics.json');
const CLIENTS_PATH = join(DATA_DIR, 'clients.json');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
const POPULARITY_PATH = join(DATA_DIR, 'popularity.json');
const UPDATE_PATH = join(DATA_DIR, 'update.json');
const OAUTH_DIR = join(DATA_DIR, 'oauth');
// `HYPERGATE_PORT` first, because that's what the shell and CLI read: a user who
// sets only `PORT` still works, but one who sets only `HYPERGATE_PORT` would
// otherwise get a daemon on 7777 that the CLI then looks for somewhere else.
const PORT = Number(process.env.HYPERGATE_PORT ?? process.env.PORT ?? 7777);
const VERSION = '0.17.0';
/**
 * `--stdio` is a transient spawn by an agent harness, not the resident daemon.
 * It deliberately does NOT open the durable store: the rolled-up aggregates are
 * written as absolute values, so a short-lived process starting from an empty
 * in-memory state would stomp the resident daemon's counts with lower ones.
 * (Its calls therefore go unrecorded, exactly as before this store existed.)
 */
const STDIO_MODE = process.argv.includes('--stdio');
/** How long a fetched popularity snapshot stays fresh before we refetch (24h). */
const POPULARITY_TTL = 24 * 60 * 60 * 1000;
/** Where OAuth providers send the user back after the browser login. */
const OAUTH_REDIRECT = `http://localhost:${PORT}/oauth/callback`;

const loadConfig = (): ManagedServerConfig[] => {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as ManagedServerConfig[];
  } catch {
    /* fall through to empty */
  }
  return [];
};
const saveConfig = (servers: ManagedServerConfig[]): void => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(servers, null, 2));
};

/**
 * The durable store (SQLite/WAL). Undefined in `--stdio` mode (see STDIO_MODE)
 * and on a runtime without `node:sqlite`, in which case analytics fall back to
 * the legacy JSON snapshot below and stay in-memory-only.
 */
const store = STDIO_MODE ? undefined : openStore(DATA_DIR);

/** Legacy fallback: the pre-SQLite snapshot, used only when the store is unavailable. */
const loadLegacyAnalytics = (): AnalyticsSnapshot | undefined => {
  try {
    if (existsSync(ANALYTICS_PATH)) return JSON.parse(readFileSync(ANALYTICS_PATH, 'utf8')) as AnalyticsSnapshot;
  } catch {
    /* ignore a corrupt snapshot */
  }
  return undefined;
};

/** Connected agents: named gateway tokens each scoped to an allow-list of servers. */
const loadClients = (): AgentClient[] => {
  try {
    if (existsSync(CLIENTS_PATH)) {
      const arr = JSON.parse(readFileSync(CLIENTS_PATH, 'utf8')) as AgentClient[];
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    /* fall through to empty */
  }
  return [];
};
const saveClients = (list: AgentClient[]): void => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CLIENTS_PATH, JSON.stringify(list, null, 2));
};

/** Trailing debounce: coalesce bursts of writes into one. */
const debounce = (fn: () => void, ms: number): (() => void) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
};

/**
 * The gateway bearer token: generated once, persisted, never logged.
 *
 * Resolution order is keychain → legacy plaintext file → mint a new one. When
 * the shell launches the daemon it passes the token in `HYPERGATE_TOKEN` (which
 * wins over all of this), so in the normal desktop flow the token lives only in
 * the OS keychain and no plaintext copy is ever written. A bare daemon with no
 * shell keeps the old file behaviour.
 */
const loadToken = (): string => {
  if (shell.hasShell()) {
    const fromKeychain = shell.secretGet('gateway-token')?.trim();
    if (fromKeychain) return fromKeychain;
  }
  try {
    if (existsSync(TOKEN_PATH)) {
      const t = readFileSync(TOKEN_PATH, 'utf8').trim();
      if (t) return t;
    }
  } catch {
    /* regenerate below */
  }
  const t = randomBytes(24).toString('hex');
  // Prefer the keychain for a freshly minted token; only fall back to a file.
  if (shell.hasShell() && shell.secretSet('gateway-token', t)) return t;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, t);
  return t;
};

// ── desktop / service settings (autostart + tray behavior) ─────────────────
// Preferences live in ~/.hypergate/settings.json. `runOnStartup` is backed by a
// real OS login item, so it reflects reality even when changed outside the app.
//
// The login item goes through the `hypergate` shell binary when it is installed
// (it owns the idiomatic per-user mechanism on each platform), and is written by
// the daemon itself when it isn't — see autostart.ts. Either way the toggle
// works, which it previously did not on an install with no shell.
const pexecFile = promisify(execFile);

// ── popularity ranking (lazy, cached; never fetched on boot) ────────────────
// The catalog sorts the recommended set first, then the rest by popularity. We
// fetch that signal (npm monthly downloads, else GitHub stars) ONLY when the UI
// asks — i.e. when the user opens the catalog — never on boot, so SPEC §1's
// "no outbound calls on its own" invariant holds. Results cache to disk (24h).
interface PopularityCache {
  fetchedAt: number;
  scores: PopularityMap;
}
const loadPopularityCache = (): PopularityCache | undefined => {
  try {
    if (existsSync(POPULARITY_PATH)) return JSON.parse(readFileSync(POPULARITY_PATH, 'utf8')) as PopularityCache;
  } catch {
    /* ignore a corrupt cache */
  }
  return undefined;
};
const savePopularityCache = (c: PopularityCache): void => {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(POPULARITY_PATH, JSON.stringify(c));
  } catch {
    /* best-effort; popularity is non-critical */
  }
};
/** The npm package a curated `npx` entry installs, minus any trailing @version. */
const npmPackage = (e: RegistryEntry): string | undefined => {
  if (e.command !== 'npx') return undefined;
  const arg = (e.args ?? []).find((a) => a && !a.startsWith('-'));
  if (!arg) return undefined;
  const at = arg.lastIndexOf('@');
  return (at > 0 ? arg.slice(0, at) : arg) || undefined; // keep a leading scope @
};
/** `owner/repo` from a github.com homepage, for a GitHub-stars fallback. */
const githubRepo = (e: RegistryEntry): string | undefined => {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(e.homepage ?? '');
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : undefined;
};
const fetchNpmDownloads = async (pkg: string, signal: AbortSignal): Promise<number | undefined> => {
  const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${pkg.replace('/', '%2F')}`, { signal });
  if (!res.ok) return undefined;
  const d = (await res.json()) as { downloads?: number };
  return typeof d.downloads === 'number' ? d.downloads : undefined;
};
const fetchGithubStars = async (repo: string, signal: AbortSignal): Promise<number | undefined> => {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    signal,
    headers: { 'User-Agent': 'hypergate', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return undefined;
  const d = (await res.json()) as { stargazers_count?: number };
  return typeof d.stargazers_count === 'number' ? d.stargazers_count : undefined;
};
/** Score every curated entry we can (npm downloads first, GitHub stars fallback). */
const computePopularity = async (): Promise<PopularityMap> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const scores: PopularityMap = {};
  try {
    await Promise.allSettled(
      REGISTRY.map(async (e) => {
        const pkg = npmPackage(e);
        let score = pkg ? await fetchNpmDownloads(pkg, ctrl.signal).catch(() => undefined) : undefined;
        if (score === undefined) {
          const repo = githubRepo(e);
          if (repo) score = await fetchGithubStars(repo, ctrl.signal).catch(() => undefined);
        }
        if (typeof score === 'number') scores[e.id] = score;
      }),
    );
  } finally {
    clearTimeout(timer);
  }
  return scores;
};

// ── updates (lazy, cached; never fetched on boot) ───────────────────────────
// "Is there a newer Hypergate, and can we install it for you." The check is an
// outbound call, so it follows the popularity rule exactly: only when the UI asks
// (i.e. when someone opens the manager, or presses Check for updates), cached to
// disk for a day, soft-failing to whatever we last knew. `GET /api/update` never
// touches the network at all.
//
// Feeds, in order: the npm registry (the package `npm install -g` would fetch),
// then the GitHub release. Either URL can be pointed elsewhere for a test or an
// internal mirror.
const UPDATE_TTL = 24 * 60 * 60 * 1000;
const NPM_URL = process.env.HYPERGATE_UPDATE_NPM_URL ?? NPM_FEED_URL;
const GITHUB_URL = process.env.HYPERGATE_UPDATE_GITHUB_URL ?? GITHUB_FEED_URL;

interface UpdateCache {
  checkedAt: string;
  latest?: string;
  source?: 'npm' | 'github';
  releaseUrl?: string;
  error?: string;
  /** The files an update would pull, resolved during the check that found it. */
  assets?: UpdateAsset[];
}

/** The one download job, watched by the UI and handed to the shell to install. */
const updater = new Updater(DATA_DIR);
const loadUpdateCache = (): UpdateCache | undefined => {
  try {
    if (existsSync(UPDATE_PATH)) return JSON.parse(readFileSync(UPDATE_PATH, 'utf8')) as UpdateCache;
  } catch {
    /* ignore a corrupt cache */
  }
  return undefined;
};
const saveUpdateCache = (c: UpdateCache): void => {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(UPDATE_PATH, JSON.stringify(c));
  } catch {
    /* best-effort; an update check is not critical */
  }
};

/**
 * How this copy was installed, which decides whether we may replace it.
 * `process.execPath` matters as much as the module path: in the compiled
 * standalone daemon there is no module path on disk at all.
 */
const installChannel = (): InstallChannel =>
  detectInstallChannel({
    daemonPath: fileURLToPath(import.meta.url),
    execPath: process.execPath,
    platform: process.platform,
  });

const fetchJson = async (url: string, signal: AbortSignal): Promise<unknown | undefined> => {
  const res = await fetch(url, { signal, headers: { 'User-Agent': 'hypergate', Accept: 'application/json' } });
  if (!res.ok) return undefined;
  return (await res.json()) as unknown;
};

/** The platform shell package for this machine, on whichever registry we use. */
const SHELL_PKG = shellPackageFor(process.platform, process.arch);
const SHELL_NPM_URL = NPM_URL.replace(/\/[^/]+$/, `/${SHELL_PKG}`);

/**
 * Ask the feeds what the newest published version is, and (only when that turns
 * out to be an upgrade) what downloading it would involve. Never throws.
 *
 * Resolving the assets is deferred behind `isNewerVersion` on purpose: the
 * common answer is "you're current", and that must stay a single lookup.
 */
const fetchLatest = async (): Promise<UpdateCache> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const checkedAt = new Date().toISOString();
  try {
    const npmDoc = await fetchJson(NPM_URL, ctrl.signal).catch(() => undefined);
    const fromNpm = latestFromNpm(npmDoc);
    if (fromNpm) {
      const assets = isNewerVersion(fromNpm, VERSION)
        ? assetsFromNpm(
            { main: npmDoc, shell: await fetchJson(SHELL_NPM_URL, ctrl.signal).catch(() => undefined) },
            fromNpm,
            process.platform,
            process.arch,
          )
        : [];
      return { checkedAt, latest: fromNpm, source: 'npm', releaseUrl: releaseUrlFor(fromNpm), assets };
    }
    const ghDoc = await fetchJson(GITHUB_URL, ctrl.signal).catch(() => undefined);
    const fromGithub = latestFromGithub(ghDoc);
    if (fromGithub) {
      // The release carries the same npm tarballs as attachments, which is what
      // lets an update install before anything is published to npm at all.
      const assets = isNewerVersion(fromGithub, VERSION) ? assetsFromGithub(ghDoc, fromGithub, process.platform, process.arch) : [];
      return { checkedAt, latest: fromGithub, source: 'github', releaseUrl: releaseUrlFor(fromGithub), assets };
    }
    // Neither feed has a release. Today that is simply the truth (nothing is
    // published yet), so it is recorded as a successful check with no version
    // rather than an error the UI has to apologise for.
    return { checkedAt };
  } catch (e) {
    return { checkedAt, error: e instanceof Error ? e.message : 'could not reach the update feed' };
  } finally {
    clearTimeout(timer);
  }
};

/** The `/api/update` payload: what we know, plus what updating would take here. */
const updateInfo = (cache = loadUpdateCache()): UpdateInfo => {
  const channel = installChannel();
  const latest = cache?.latest;
  const available = isNewerVersion(latest, VERSION);
  // The plan names the version it would install, so it only mentions one when
  // that version is actually an upgrade.
  const plan = updatePlan(channel, available ? latest : undefined, process.platform);
  const assets = available ? (cache?.assets ?? []) : [];
  const staged = updater.staged();
  const size = assets.reduce((n, a) => n + (a.size ?? 0), 0);
  return {
    current: VERSION,
    latest,
    updateAvailable: available,
    checkedAt: cache?.checkedAt,
    source: cache?.source,
    releaseUrl: cache?.releaseUrl,
    channel,
    error: cache?.error,
    // A staged copy of a version we have since outgrown is not an offer.
    staged: staged && isNewerVersion(staged.version, VERSION) ? staged.version : undefined,
    skipped: loadSettings().skippedUpdate,
    canDownload: assets.length > 0,
    downloadSize: size || undefined,
    ...plan,
  };
};

/** The assets for a version, from the cache the last check filled in. */
const updateAssets = (version: string): UpdateAsset[] => {
  const cache = loadUpdateCache();
  return cache?.latest === version ? (cache.assets ?? []) : [];
};

// ── CLI detection (local, shell-free; powers the CLIs section) ──────────────
// "Is this command-line tool installed, where, and what version." Pure PATH
// scanning + a bounded `--version` probe — no network, no shell (so an ad-hoc
// search can't be turned into command injection).
const WIN = process.platform === 'win32';
// Prefer real executable extensions (node.exe, npm.cmd) over an extensionless
// shim of the same name — a bare name isn't runnable on Windows anyway, and the
// shim (e.g. a git-bash script) can't be version-probed. Extensionless is tried
// last so tools that only ship that way are still detected.
const PATH_EXTS = WIN
  ? [...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean), '']
  : [''];
/** Resolve a bare command name to an absolute path on PATH, or undefined. */
const resolveOnPath = (command: string): string | undefined => {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of PATH_EXTS) {
      const candidate = join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* unreadable dir/entry — skip */
      }
    }
  }
  return undefined;
};
/** First version-looking token in some `--version` output. */
const parseVersion = (out: string): string | undefined => {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  const m = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return m ? m[0] : line.slice(0, 48);
};
/** Best-effort `<file> --version`, bounded + shell-free. `.cmd`/`.bat` go via cmd.exe. */
const probeVersion = async (file: string, args: string[]): Promise<string | undefined> => {
  const opts = { timeout: 4000, windowsHide: true, maxBuffer: 1_000_000 } as const;
  const low = file.toLowerCase();
  const viaCmd = WIN && (low.endsWith('.cmd') || low.endsWith('.bat'));
  try {
    const { stdout, stderr } = viaCmd
      ? await pexecFile(process.env.ComSpec ?? 'cmd.exe', ['/c', file, ...args], opts)
      : await pexecFile(file, args, opts);
    return parseVersion(stdout || stderr);
  } catch (e) {
    // Many tools print --version to stderr and/or exit non-zero — still usable.
    const err = e as { stdout?: string; stderr?: string };
    return parseVersion(`${err.stdout ?? ''}\n${err.stderr ?? ''}`) || undefined;
  }
};
/** Detect every known CLI (parallel, each bounded). */
const detectClis = async (): Promise<CliStatus[]> =>
  Promise.all(
    KNOWN_CLIS.map(async (c): Promise<CliStatus> => {
      const path = resolveOnPath(c.command);
      if (!path) return { ...c, found: false };
      return { ...c, found: true, path, version: await probeVersion(path, c.versionArgs ?? ['--version']) };
    }),
  );
// Short in-memory memo so opening/closing the section doesn't re-spawn ~20 probes.
let cliMemo: { at: number; result: CliStatus[] } | undefined;
const detectClisCached = async (): Promise<CliStatus[]> => {
  if (cliMemo && Date.now() - cliMemo.at < 10_000) return cliMemo.result;
  const result = await detectClis();
  cliMemo = { at: Date.now(), result };
  return result;
};

// ── connecting agent harnesses (the "Connected agents" one-click) ───────────
// Same PATH scan as above, over the clients we know how to wire up. For a `cli`
// client we can run its own `mcp add` for the user; the argv comes from the
// table in @hypergate/core, never from the request, and is spawned shell-free.
const connectTargetStatus = async (): Promise<ConnectTargetStatus[]> =>
  Promise.all(
    CONNECT_TARGETS.map(async (t): Promise<ConnectTargetStatus> => {
      const configPath = configPathFor(t.id, process.platform);
      if (t.method !== 'cli' || !t.command) return { ...t, found: true, configPath };
      const path = resolveOnPath(t.command);
      if (!path) return { ...t, found: false, configPath };
      return { ...t, found: true, configPath, version: await probeVersion(path, ['--version']) };
    }),
  );
let connectMemo: { at: number; result: ConnectTargetStatus[] } | undefined;
const connectTargetsCached = async (): Promise<ConnectTargetStatus[]> => {
  if (connectMemo && Date.now() - connectMemo.at < 10_000) return connectMemo.result;
  const result = await connectTargetStatus();
  connectMemo = { at: Date.now(), result };
  return result;
};
/**
 * Run a client's CLI. Bounded, shell-free, output captured for the UI so a
 * failure shows the client's own message instead of a bare "didn't work".
 * `.cmd`/`.bat` shims go through cmd.exe — Node refuses to spawn them directly.
 */
const runClientCli = async (file: string, args: string[]): Promise<{ ok: boolean; output: string }> => {
  const opts = { timeout: 30_000, windowsHide: true, maxBuffer: 1_000_000 } as const;
  const low = file.toLowerCase();
  const viaCmd = WIN && (low.endsWith('.cmd') || low.endsWith('.bat'));
  try {
    const { stdout, stderr } = viaCmd
      ? await pexecFile(process.env.ComSpec ?? 'cmd.exe', ['/c', file, ...args], opts)
      : await pexecFile(file, args, opts);
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    return { ok: false, output: out || err.message || 'the command failed' };
  }
};

const defaultSettings = (): DaemonSettings => ({ runOnStartup: false, startMinimized: true, closeAction: 'ask' });
const loadSettings = (): DaemonSettings => {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Partial<DaemonSettings>;
      return { ...defaultSettings(), ...s };
    }
  } catch {
    /* fall through to defaults */
  }
  return defaultSettings();
};
const saveSettings = (s: DaemonSettings): void => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
};

/** The `/api/settings` payload: persisted prefs reconciled with the real OS autostart state. */
const settingsInfo = (): SettingsInfo => {
  const s = loadSettings();
  const startupVia = autostart.via();
  return {
    // Read from the OS, not from the file: the login item can be removed in
    // Task Manager or System Settings, and the toggle must not lie about it.
    runOnStartup: startupVia === 'none' ? false : autostart.enabled(),
    startMinimized: s.startMinimized,
    closeAction: s.closeAction,
    platform: process.platform,
    startupSupported: startupVia !== 'none',
    startupVia,
    startupCommand: autostart.startupCommand(),
    skippedUpdate: s.skippedUpdate,
  };
};

// ── OAuth for remote servers ───────────────────────────────────────────────
// Each remote server's OAuth state (registered client, tokens, PKCE verifier,
// CSRF state) is one blob. It now lives in the OS keychain under `oauth:<id>`,
// via the `hypergate` shell binary, instead of plaintext JSON under
// ~/.hypergate/oauth/. The whole blob is one keychain entry, cached in memory,
// so a boot costs one subprocess per remote server rather than one per key.
//
// Without the shell (or without a working keychain, e.g. headless Linux with no
// Secret Service) this falls back to exactly the previous file behaviour, so
// nothing breaks; the grants are simply no better protected than before.
const oauthFile = (id: string): string => join(OAUTH_DIR, `${encodeURIComponent(id)}.json`);
const readOAuthFile = (id: string): Record<string, string> => {
  try {
    if (existsSync(oauthFile(id))) return JSON.parse(readFileSync(oauthFile(id), 'utf8')) as Record<string, string>;
  } catch {
    /* corrupt file → start fresh */
  }
  return {};
};
const writeOAuthFile = (id: string, blob: Record<string, string>): void => {
  mkdirSync(OAUTH_DIR, { recursive: true });
  writeFileSync(oauthFile(id), JSON.stringify(blob, null, 2));
};

/** Keychain entry name for one server's grant blob. */
const oauthKey = (id: string): string => `oauth:${id}`;
/** In-memory cache, so repeated `load()` calls don't each spawn a subprocess. */
const oauthCache = new Map<string, Record<string, string>>();
/** Whether the keychain is usable. Probed once; false means stay on files. */
let keychainOk: boolean | undefined;
const useKeychain = (): boolean => {
  if (keychainOk === undefined) keychainOk = shell.hasShell() && shell.keychainAvailable();
  return keychainOk;
};

const readOAuth = (id: string): Record<string, string> => {
  const cached = oauthCache.get(id);
  if (cached) return cached;

  let blob: Record<string, string> = {};
  if (useKeychain()) {
    const raw = shell.secretGet(oauthKey(id));
    if (raw) {
      try {
        blob = JSON.parse(raw) as Record<string, string>;
      } catch {
        /* corrupt entry → start fresh */
      }
    } else {
      // One-time migration: adopt an existing plaintext grant, then delete it.
      const fromFile = readOAuthFile(id);
      if (Object.keys(fromFile).length > 0 && shell.secretSet(oauthKey(id), JSON.stringify(fromFile))) {
        blob = fromFile;
        try {
          rmSync(oauthFile(id));
          process.stderr.write(`[oauth] moved ${id} grant into the OS keychain\n`);
        } catch {
          /* best-effort */
        }
      }
    }
  } else {
    blob = readOAuthFile(id);
  }
  oauthCache.set(id, blob);
  return blob;
};

const writeOAuth = (id: string, blob: Record<string, string>): void => {
  oauthCache.set(id, blob);
  if (useKeychain() && shell.secretSet(oauthKey(id), JSON.stringify(blob))) return;
  writeOAuthFile(id, blob);
};

const secretStore = (id: string): OAuthStore => ({
  load: (key) => readOAuth(id)[key],
  save: (key, value) => writeOAuth(id, { ...readOAuth(id), [key]: value }),
  remove: (key) => {
    const blob = { ...readOAuth(id) };
    delete blob[key];
    writeOAuth(id, blob);
  },
});
/**
 * Pre-registered OAuth credentials for a provider that lacks dynamic registration
 * (e.g. GitHub). Resolved from the server config, or from env so they can be set
 * without a rebuild and kept out of the repo/catalog:
 *   HYPERGATE_CLIENTID_GITHUB=Iv1...   HYPERGATE_CLIENTSECRET_GITHUB=...
 * The secret is only needed by servers that require client auth at the token
 * endpoint even with PKCE; DCR providers (Context7) need neither.
 */
const envKey = (prefix: string, id: string): string | undefined =>
  process.env[`${prefix}_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
const resolvedClientId = (cfg: ManagedServerConfig): string | undefined => cfg.clientId || envKey('HYPERGATE_CLIENTID', cfg.id);
const resolvedClientSecret = (cfg: ManagedServerConfig): string | undefined => cfg.clientSecret || envKey('HYPERGATE_CLIENTSECRET', cfg.id);
const makeProvider = (cfg: ManagedServerConfig): HypergateOAuthProvider =>
  new HypergateOAuthProvider(secretStore(cfg.id), {
    redirectUrl: OAUTH_REDIRECT,
    clientName: HYPERGATE_OAUTH_IDENTITY.clientName,
    clientUri: HYPERGATE_OAUTH_IDENTITY.clientUri,
    logoUri: HYPERGATE_OAUTH_IDENTITY.logoUri,
    softwareId: HYPERGATE_OAUTH_IDENTITY.softwareId,
    clientId: resolvedClientId(cfg),
    clientSecret: resolvedClientSecret(cfg),
    scope: cfg.scope,
  });
/** A remote server that uses OAuth and has no usable token yet needs the user to sign in. */
const needsAuth = (cfg: ManagedServerConfig): boolean =>
  cfg.runtime === 'remote' && cfg.auth !== 'none' && !makeProvider(cfg).hasTokens();

// ── which account each remote server is signed in as ────────────────────────
// "Connected" is only half the answer: a remote server is reached with one
// person's grant, and which one decides what the agent can see. The cheap route
// is the grant itself (an id_token, or a JWT access token) and costs nothing.
// When the token is opaque — which plenty of providers issue — we ask the
// provider once, following the same discovery chain the MCP OAuth flow already
// used, and cache the answer in the grant blob so it is one call per sign-in,
// not one per poll.
const K_ACCOUNT = 'account';

/** Servers we've already asked the network about, so a miss costs one attempt. */
const accountProbed = new Set<string>();

/**
 * Derived accounts, memoised against the access token they came from.
 *
 * `/api/servers` is polled every couple of seconds and would otherwise decode a
 * JWT per remote server every time. Keying on the token means a refresh or a
 * re-login invalidates the memo for free; a successful `userinfo` probe has to
 * clear it explicitly, since it lands after the "nothing found" answer was
 * already memoised.
 */
const accountMemo = new Map<string, { token: string; account?: ServerAccount }>();

const cachedAccount = (id: string): ServerAccount | undefined => {
  const raw = secretStore(id).load(K_ACCOUNT);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ServerAccount;
  } catch {
    return undefined;
  }
};
const cacheAccount = (id: string, account: ServerAccount): void => {
  secretStore(id).save(K_ACCOUNT, JSON.stringify(account));
};
const forgetAccount = (id: string): void => {
  secretStore(id).remove(K_ACCOUNT);
  accountProbed.delete(id);
  accountMemo.delete(id);
};

/**
 * Drop a server's grant entirely: tokens, the registered client, the PKCE
 * verifier, the CSRF state, the cached account — the whole entry, not its keys
 * one at a time.
 *
 * Removing a server used to leave this behind. The config row went, the
 * process stopped, and the grant stayed in the keychain forever, so re-adding
 * the same server came back already signed in as whoever set it up last, and
 * "remove" quietly meant "hide". A grant is the most sensitive thing we hold
 * on a user's behalf; when they remove the server they are done with it.
 */
const deleteOAuth = (id: string): void => {
  oauthCache.delete(id);
  accountProbed.delete(id);
  accountMemo.delete(id);
  if (useKeychain()) shell.secretDelete(oauthKey(id));
  try {
    rmSync(oauthFile(id));
  } catch {
    /* absent is the outcome we wanted anyway */
  }
};

/** The identity the stored grant states about itself. No network, always cheap. */
const accountFromGrant = (cfg: ManagedServerConfig): ServerAccount | undefined => {
  if (cfg.runtime !== 'remote' || cfg.auth === 'none') return undefined;
  const tokens = makeProvider(cfg).tokens();
  if (!tokens?.access_token) return undefined;
  const memo = accountMemo.get(cfg.id);
  if (memo?.token === tokens.access_token) return memo.account;
  const account = accountFromTokens(tokens) ?? cachedAccount(cfg.id);
  accountMemo.set(cfg.id, { token: tokens.access_token, account });
  return account;
};

const fetchJsonOr = async (url: string, signal: AbortSignal, token?: string): Promise<unknown | undefined> => {
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'hypergate',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Ask the provider who this grant belongs to, once.
 *
 * The chain is the MCP/OAuth one: the resource server's RFC 9728 document names
 * its authorization server, whose metadata names a `userinfo` endpoint, which
 * the access token can read. Every hop is optional and every failure is silent —
 * a server with no identity endpoint is a normal server, not a broken one.
 *
 * The token only ever goes to the issuer's own origin (enforced in
 * `userinfoEndpoint`), because the metadata that named the endpoint was fetched
 * without authentication.
 */
const probeAccount = async (cfg: ManagedServerConfig): Promise<ServerAccount | undefined> => {
  const provider = makeProvider(cfg);
  const token = provider.tokens()?.access_token;
  if (!token || !cfg.url) return undefined;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const resource = new URL(cfg.url);
    // The issuer as the grant itself names it beats discovery when present.
    const fromIss = (() => {
      const iss = decodeJwtClaims(token)?.iss;
      return typeof iss === 'string' ? iss : undefined;
    })();
    const prm = await fetchJsonOr(new URL('/.well-known/oauth-protected-resource', resource.origin).toString(), ctrl.signal);
    const issuers = [fromIss, ...authorizationServersOf(prm), resource.origin].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );

    for (const issuer of [...new Set(issuers)]) {
      let origin: string;
      try {
        origin = new URL(issuer).origin;
      } catch {
        continue;
      }
      for (const wellKnown of ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server']) {
        const metadata = await fetchJsonOr(new URL(wellKnown, origin).toString(), ctrl.signal);
        const endpoint = userinfoEndpoint(metadata, origin);
        if (!endpoint) continue;
        const account = accountFromUserinfo(await fetchJsonOr(endpoint, ctrl.signal, token));
        if (account) return account;
      }
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Decorate the supervisor's statuses with the account behind each remote server.
 *
 * Synchronous by design: `/api/servers` is polled every couple of seconds, and
 * must never wait on a provider. A server whose grant says nothing gets one
 * background probe, and the answer shows up on the next poll.
 */
const withAccounts = (list: ServerStatus[]): ServerStatus[] =>
  list.map((s) => {
    const cfg = servers.find((c) => c.id === s.id);
    if (!cfg || cfg.runtime !== 'remote' || cfg.auth === 'none') return s;
    const signedIn = makeProvider(cfg).hasTokens();
    if (!signedIn) return s;
    const account = accountFromGrant(cfg);
    if (account) return { ...s, signedIn, account };
    // Nothing free to show. Ask the provider once, in the background.
    if (!accountProbed.has(cfg.id)) {
      accountProbed.add(cfg.id);
      void probeAccount(cfg)
        .then((found) => {
          if (!found) return;
          cacheAccount(cfg.id, found);
          // The memo already recorded "nothing found" for this token; drop it,
          // or the answer we just fetched would never be read back.
          accountMemo.delete(cfg.id);
        })
        .catch(() => {
          /* an unidentifiable account is not an error */
        });
    }
    return { ...s, signedIn };
  });

/**
 * Fill in the last log line for a server whose in-memory ring is empty.
 *
 * The supervisor's ring starts empty on every boot, but the durable rows do
 * not, so without this the collapsed rows would go blank after a restart and
 * fill back in one server at a time as each said something. One indexed
 * `LIMIT 1` per server per poll, and only for the servers that need it.
 */
const withLastLog = (list: ServerStatus[]): ServerStatus[] =>
  list.map((s) => (s.lastLog || !store ? s : { ...s, lastLog: store.logs(s.id, 1)[0]?.line }));

// Set to a debounced store writer in HTTP mode; stays a no-op in stdio mode so a
// transient `--stdio` spawn never clobbers the resident daemon's aggregates.
let persistAnalytics: () => void = () => {};
const supervisor = new Supervisor({
  onUsage: (e) => {
    // Queue the raw call for durable history (O(1)); the SQLite write is batched
    // into the debounced flush so the gateway's hot path never touches the disk.
    store?.appendEvent(e);
    persistAnalytics();
  },
  onLog: (serverId, line) => {
    store?.appendLog(serverId, line);
    persistAnalytics();
  },
  // The supervisor connects remote servers with this provider (attaches + refreshes
  // the bearer token); the interactive login is driven by the daemon's OAuth routes.
  authProviderFor: (cfg) => (cfg.runtime === 'remote' && cfg.auth !== 'none' ? makeProvider(cfg) : undefined),
  // Enforces per-server resource limits by spawning through `hypergate
  // sandbox-exec`. Undefined when the shell is not installed, in which case a
  // limited server starts unsandboxed and says so in its logs.
  launcher: shell.shellBin(),
});
let servers = loadConfig();

const startEnabled = async (): Promise<void> => {
  for (const s of servers) {
    // A server the user stopped stays in the roster, just not running: `list()`
    // is what /api/servers serves, so skipping it entirely made a stopped server
    // disappear from the UI on the next boot while still living in servers.json.
    if (!s.enabled) {
      supervisor.register(s);
      continue;
    }
    // Don't attempt a token-less remote connect — just surface it as authorizing.
    if (needsAuth(s)) supervisor.markAuthorizing(s);
    else await supervisor.start(s);
  }
};

/**
 * Drive the MCP OAuth flow for a remote server. Returns `{ authorized }` when
 * tokens already exist (or were just minted), otherwise `{ authUrl }` — the
 * browser URL the user must open to sign in. `authorizationCode` completes the
 * exchange on the callback.
 */
const runOAuth = async (
  cfg: ManagedServerConfig,
  authorizationCode?: string,
): Promise<{ authorized: boolean; authUrl?: string; error?: string }> => {
  const provider = makeProvider(cfg);
  try {
    if (authorizationCode) {
      const done = await auth(provider, { serverUrl: cfg.url ?? '', authorizationCode });
      if (done !== 'AUTHORIZED') return { authorized: false, error: 'token exchange did not complete' };
      provider.clearFlowState();
      return { authorized: true };
    }
    // Fresh authorize: clear any stale PKCE/state so we always start clean.
    provider.clearFlowState();
    const result = await auth(provider, { serverUrl: cfg.url ?? '' });
    if (result === 'AUTHORIZED') return { authorized: true };
    return { authorized: false, authUrl: provider.lastAuthorizationUrl() };
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    // The common gotcha: the provider needs a pre-registered app (id [+ secret]).
    const ID = cfg.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (/dynamic client registration/i.test(msg) && !resolvedClientId(cfg))
      msg = `${cfg.name} doesn't support automatic app registration — it needs a pre-registered OAuth app. Register one (callback ${OAUTH_REDIRECT}) and set HYPERGATE_CLIENTID_${ID} (and HYPERGATE_CLIENTSECRET_${ID} if the provider requires a secret, e.g. GitHub).`;
    return { authorized: false, error: msg };
  }
};

/** Find the managed remote server whose live OAuth flow used this CSRF `state`. */
const serverForState = (state: string): ManagedServerConfig | undefined =>
  servers.find((s) => s.runtime === 'remote' && secretStore(s.id).load('state') === state);

/**
 * Is a resident daemon already serving on our port?
 *
 * Deliberately cheap and deliberately quiet: one `/health` GET on a short leash,
 * and any failure at all means "no daemon", because the only thing riding on the
 * answer is whether a stdio spawn proxies or runs its own servers.
 */
const residentDaemon = async (): Promise<boolean> => {
  try {
    const res = await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
};

/**
 * The credential a stdio spawn presents to the resident gateway.
 *
 * `HYPERGATE_TOKEN` when the shell launched us, else — if the spawn declared a
 * name via `HYPERGATE_STDIO_AGENT` — a scoped agent token fetched from the
 * daemon, else the master token from the keychain.
 *
 * The middle case is what a packaged bundle uses (the .mcpb runs `--stdio` with
 * `HYPERGATE_STDIO_AGENT=claude-desktop`). It matters because the alternative is
 * the master token: an agent shows up in the manager under its own name, reaches
 * only the servers it's allowed, and can be revoked on its own. It is created on
 * first use, which is the same bargain the connect button makes.
 *
 * Only when the spawn asks for it, though: a bare `hypergated --stdio` keeps the
 * master token it has always used, rather than quietly minting an identity
 * nobody asked for.
 */
const stdioToken = async (): Promise<string> => {
  if (process.env.HYPERGATE_TOKEN) return process.env.HYPERGATE_TOKEN;
  const key = process.env.HYPERGATE_STDIO_AGENT?.trim();
  if (key) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/clients/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, create: true }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const agent = (await res.json()) as { token?: string };
        if (agent.token) return agent.token;
      }
    } catch {
      /* fall through to the master token */
    }
  }
  return loadToken();
};

/**
 * The stdio gateway, attached to the daemon that is already running.
 *
 * Returns false when there is nothing to attach to, so the caller can fall back
 * to being a standalone gateway.
 */
const startStdioProxy = async (): Promise<boolean> => {
  if (process.env.HYPERGATE_STDIO_PROXY === '0') return false;
  if (!(await residentDaemon())) return false;
  try {
    const token = await stdioToken();
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const upstream = new Client({ name: 'hypergate-stdio-proxy', version: VERSION }, { capabilities: {} });
    await upstream.connect(transport);
    const proxy = createProxy(upstream, { name: 'hypergate-gateway', version: VERSION });
    await proxy.connect(new StdioServerTransport());
    const { tools } = await upstream.listTools();
    process.stderr.write(`hypergated gateway (stdio → resident daemon on ${PORT}) up — ${tools.length} tool(s)\n`);
    return true;
  } catch (e) {
    // A daemon that answered /health but refused the gateway is worth saying out
    // loud: the usual cause is a token mismatch, and silently starting a second
    // fleet instead would hide it behind tools that mysteriously work.
    process.stderr.write(`hypergated: could not attach to the daemon on ${PORT} (${e instanceof Error ? e.message : e}); starting a private gateway instead\n`);
    return false;
  }
};

// ── stdio gateway mode (the single aggregated endpoint for harnesses) ──────
//
// Two shapes, decided at spawn time: proxy to the resident daemon when there is
// one (so every harness on the machine shares one fleet of servers), else start
// the enabled servers here and be the gateway (so `hypergated --stdio` still
// works on a machine where nothing else is running).
//
// Boot is sequenced with promises rather than top-level `await` throughout this
// file. Not style: a CommonJS module cannot express top-level await, and the
// standalone build (Node SEA, see scripts/build-standalone.mjs) requires its
// entry point to be CommonJS. The ordering guarantees are identical.
if (STDIO_MODE) {
  void startStdioProxy().then(async (proxied) => {
    if (proxied) return;
    await startEnabled();
    const gateway = createGateway(supervisor, { name: 'hypergate-gateway', version: VERSION }, { caller: 'stdio (local)' });
    await gateway.connect(new StdioServerTransport());
    // stdout is the MCP channel now; logs must go to stderr only.
    process.stderr.write(`hypergated gateway (stdio) up — ${supervisor.ids().length} server(s)\n`);
  });
} else {
  // ── HTTP: management API + web UI + streamable-HTTP MCP gateway ──────────
  // Restore analytics before serving so the first response already reflects
  // history. The tail matches the supervisor's in-memory event ring (EVENT_CAP);
  // everything older stays queryable via /api/usage/events.
  const EVENT_TAIL = 2000;
  supervisor.hydrate(store ? store.loadSnapshot(EVENT_TAIL) : loadLegacyAnalytics());

  /** Persist queued events/logs + the rolled-up aggregates. Cheap and idempotent. */
  const flushStore = (): void => {
    try {
      if (store) {
        store.flush(supervisor.snapshot());
        return;
      }
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(ANALYTICS_PATH, JSON.stringify(supervisor.snapshot()));
    } catch {
      /* best-effort; analytics are non-critical */
    }
  };
  persistAnalytics = debounce(flushStore, 2000);

  // Age off old rows on boot, then once a day for a long-running daemon.
  store?.prune();
  const pruneTimer = setInterval(() => store?.prune(), 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit'] as const) {
    process.once(sig, () => {
      flushStore();
      store?.close();
      if (sig !== 'beforeExit') process.exit(0);
    });
  }

  // Connected agents (scoped gateway tokens). Bumping lastUsed is debounced.
  let clients = loadClients();
  const persistClients = debounce(() => saveClients(clients), 1500);

  // Started now, awaited just before we listen: managed servers come up while
  // the rest of the server is being wired, and nothing is served until they are
  // up, which is the ordering the top-level `await` used to give.
  const booted = startEnabled();
  const TOKEN = process.env.HYPERGATE_TOKEN ?? loadToken();
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  // A minimal self-contained result page shown in the OAuth popup after sign-in.
  const oauthPage = (res: ServerResponse, ok: boolean, message: string): void => {
    const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hypergate · ${ok ? 'Connected' : 'Sign-in failed'}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#0f1117;color:#e7e9ee}
.card{max-width:420px;padding:32px 34px;border-radius:16px;background:#171a23;border:1px solid #262b38;text-align:center}
.mark{display:block;width:62px;height:62px;margin:0 auto 14px}.h{font-size:19px;font-weight:600;margin:0 0 6px;color:#a5f3fc}
.m{color:#aab0be}.ok{color:#34d399}.err{color:#f87171}</style></head>
<body><div class="card"><img class="mark" src="/favicon.svg" alt="">
<div class="h">${ok ? 'Connected' : 'Sign-in failed'}</div>
<p class="m ${ok ? 'ok' : 'err'}">${esc(message)}</p>
<p class="m">This window can be closed.</p></div>
<script>setTimeout(function(){window.close()}, ${ok ? 1500 : 6000})</script></body></html>`);
  };
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 4_000_000) req.destroy();
      });
      req.on('end', () => resolve(data));
    });
  const bearer = (req: IncomingMessage): string => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  };
  const tokenEq = (a: string, b: string): boolean =>
    a.length > 0 && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  // Resolve the caller's scope from the bearer token alone (no body needed, so an
  // unauthorized request still 401s before we parse). Master token = full access;
  // a named agent token = that agent's per-server allow-list.
  type Scope = { kind: 'master' } | { kind: 'agent'; agent: AgentClient };
  const authScope = (req: IncomingMessage): Scope | null => {
    if (process.env.HYPERGATE_NO_AUTH === '1') return { kind: 'master' };
    const got = bearer(req);
    if (!got) return null;
    if (tokenEq(got, TOKEN)) return { kind: 'master' };
    const agent = clients.find((c) => tokenEq(got, c.token));
    return agent ? { kind: 'agent', agent } : null;
  };
  /**
   * Is this request safe to treat as coming from *our own* UI (or from something
   * that isn't a browser at all)?
   *
   * The management API answers on localhost with `Access-Control-Allow-Origin: *`,
   * so any web page the user visits can fire a cross-origin POST at it. It can't
   * read the reply, but the side effect still happens, which is exactly why the
   * CLI's `stop` used a pid file instead of a shutdown route. Browsers always
   * send `Origin` on a cross-origin request, so requiring it to be our own origin
   * (or absent, i.e. curl / the CLI / a native client) closes that door. A `null`
   * origin (a sandboxed iframe or a `file://` page) is not our UI, so it is refused.
   */
  const selfOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
  };

  // Best-effort caller identity for analytics. The gateway is stateless (a fresh
  // instance per request), so we can't correlate by session; instead we capture
  // the MCP handshake's clientInfo on `initialize` and attribute the tool calls
  // that follow to that client. Falls back to an X-Client-Name header or the
  // User-Agent. All local; nothing leaves the machine.
  let lastClient: { name: string; at: number } | undefined;
  const shortUa = (ua: string): string => {
    const first = ua.split(/[\s/]/)[0]?.trim();
    return first ? first : 'http client';
  };
  const callerFor = (req: IncomingMessage, body: unknown): string => {
    const b = body as { method?: string; params?: { clientInfo?: { name?: string; version?: string } } } | undefined;
    if (b?.method === 'initialize') {
      const ci = b.params?.clientInfo;
      const name = ci?.name ? `${ci.name}${ci.version ? ` ${ci.version}` : ''}` : undefined;
      if (name) lastClient = { name, at: Date.now() };
    }
    if (lastClient && Date.now() - lastClient.at < 10 * 60_000) return lastClient.name;
    const hdr = req.headers['x-client-name'];
    if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
    return shortUa(req.headers['user-agent'] ?? '');
  };

  const gatewayInfo = (): GatewayInfo => {
    const url = `http://localhost:${PORT}/mcp`;
    return {
      url,
      token: TOKEN,
      stdioCommand: 'hypergated --stdio',
      clientSnippet: {
        mcpServers: { 'hypergate': { type: 'http', url, headers: { Authorization: `Bearer ${TOKEN}` } } },
      },
      stdioSnippet: { mcpServers: { 'hypergate': { command: 'hypergated', args: ['--stdio'] } } },
      uiUrl: `http://localhost:${PORT}/`,
    };
  };

  // An agent + its ready-to-paste connect snippet (scoped to the agent's token).
  const agentInfo = (a: AgentClient): AgentClientInfo => {
    const url = `http://localhost:${PORT}/mcp`;
    return {
      ...a,
      url,
      connectCommand: formatCommand(
        'claude',
        connectArgv('claude-code', { url, token: a.token })!.add,
        defaultShellFor(process.platform),
      ),
      clientSnippet: {
        mcpServers: { [ENTRY_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${a.token}` } } },
      },
    };
  };

  /**
   * The command a client can run to fetch this agent's headers, when running it
   * here actually works.
   *
   * Two conditions, both necessary. `hypergate` has to be on PATH, because the
   * client will resolve the same bare word later. And it has to *answer*: an
   * older shell binary on PATH has no `mcp-headers` subcommand, and writing a
   * config that calls it would leave the client unable to connect at all —
   * strictly worse than the token it would otherwise have stored. So we run it
   * once, for real, and only hand it out if headers come back.
   *
   * Memoised per daemon run (the answer is about the binary, not the agent),
   * with a short TTL so installing the CLI mid-session is noticed.
   */
  let helperMemo: { at: number; ok: boolean } | undefined;
  const HELPER_TTL = 60_000;
  const helperCommandFor = (a: AgentClient): string => `hypergate mcp-headers ${a.id}`;
  const headersHelperFor = async (a: AgentClient): Promise<string | undefined> => {
    const file = resolveOnPath('hypergate');
    if (!file) return undefined;
    if (!helperMemo || Date.now() - helperMemo.at > HELPER_TTL) {
      let ok = false;
      try {
        const opts = { timeout: 5000, windowsHide: true, maxBuffer: 100_000 } as const;
        const low = file.toLowerCase();
        const viaCmd = WIN && (low.endsWith('.cmd') || low.endsWith('.bat'));
        const { stdout } = viaCmd
          ? await pexecFile(process.env.ComSpec ?? 'cmd.exe', ['/c', file, 'mcp-headers', a.id], opts)
          : await pexecFile(file, ['mcp-headers', a.id], opts);
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        ok = typeof parsed?.Authorization === 'string' && parsed.Authorization.startsWith('Bearer ');
      } catch {
        ok = false;
      }
      helperMemo = { at: Date.now(), ok };
    }
    return helperMemo.ok ? helperCommandFor(a) : undefined;
  };

  /** Everything the UI needs to connect one agent to any client we know about. */
  const agentConnectInfo = async (a: AgentClient): Promise<AgentConnectInfo> => {
    const url = `http://localhost:${PORT}/mcp`;
    const ctx = { url, token: a.token, headersHelper: await headersHelperFor(a) };
    return {
      agentId: a.id,
      entryName: ENTRY_NAME,
      url,
      // Echoed so the UI knows which of the targets below is *this* agent's,
      // and can show that one alone instead of a strip of every other client.
      target: a.target,
      platform: process.platform,
      defaultShell: defaultShellFor(process.platform),
      shells: shellsFor(process.platform),
      targets: (await connectTargetsCached()).map((t) => agentConnectTarget(t, ctx)),
    };
  };

  /** Normalize a servers allow-list from a request body to `'*' | string[]`. */
  const normServers = (v: unknown): '*' | string[] =>
    v === '*' ? '*' : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  // Built web UI. Three layouts to find it in, tried in order:
  //   1. `HYPERGATE_UI_DIR`, which the npm package's wrapper sets explicitly.
  //   2. `web/` beside the running executable — the installed layout, where the
  //      daemon is a single compiled binary and `import.meta.url` points inside
  //      it rather than at anything on disk.
  //   3. `apps/web/dist` relative to this module, which is the repo.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_UI = resolve(HERE, '../../web/dist');
  const UI_CANDIDATES = [
    process.env.HYPERGATE_UI_DIR,
    resolve(dirname(process.execPath), 'web'),
    REPO_UI,
  ].filter((p): p is string => Boolean(p));
  const UI_DIR = resolve(UI_CANDIDATES.find((p) => existsSync(join(p, 'index.html'))) ?? REPO_UI);
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  const serveUi = (res: ServerResponse, pathname: string): void => {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = resolve(UI_DIR, rel);
    if (file.startsWith(UI_DIR) && existsSync(file) && extname(file) in MIME) {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] });
      res.end(readFileSync(file));
      return;
    }
    if (existsSync(join(UI_DIR, 'index.html'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(UI_DIR, 'index.html')));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`hypergated ${VERSION} — build the web UI (npm run build) to serve it here.\n`);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const { pathname } = url;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
      });
      return res.end();
    }

    // ── the aggregated MCP endpoint (streamable HTTP, stateless) ──────────
    if (pathname === '/mcp') {
      const scope = authScope(req);
      if (!scope) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      try {
        const body = JSON.parse(await readBody(req));
        let caller: string;
        let allowServer: ((id: string) => boolean) | undefined;
        if (scope.kind === 'agent') {
          caller = scope.agent.name;
          const allow = scope.agent.servers;
          allowServer = (id) => allow === '*' || allow.includes(id);
          scope.agent.lastUsed = new Date().toISOString();
          persistClients();
        } else {
          caller = callerFor(req, body);
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const gateway = createGateway(supervisor, { name: 'hypergate-gateway', version: VERSION }, { caller, allowServer });
        res.on('close', () => {
          void transport.close();
          void gateway.close();
        });
        await gateway.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) json(res, 400, { error: e instanceof Error ? e.message : 'bad_request' });
      }
      return;
    }

    // ── OAuth callback: the provider redirects the browser back here ──────────
    if (pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const oauthErr = url.searchParams.get('error');
      if (oauthErr) return oauthPage(res, false, `Authorization was denied (${oauthErr}).`);
      if (!code || !state) return oauthPage(res, false, 'Missing authorization code or state.');
      const cfg = serverForState(state);
      if (!cfg) return oauthPage(res, false, 'Unknown or expired authorization request. Try adding the server again.');
      const result = await runOAuth(cfg, code);
      if (!result.authorized) return oauthPage(res, false, `Could not complete sign-in: ${result.error ?? 'unknown error'}`);
      // A fresh grant may be a different person; the old label must not stick.
      forgetAccount(cfg.id);
      const live = servers.find((s) => s.id === cfg.id);
      if (live) {
        live.enabled = true;
        saveConfig(servers);
        await supervisor.start(live);
      }
      return oauthPage(res, true, `${cfg.name} is connected. You can close this tab and return to Hypergate.`);
    }

    if (pathname === '/health') return json(res, 200, { ok: true, service: 'hypergated', version: VERSION, servers: supervisor.list().length });
    if (pathname === '/api/registry') return json(res, 200, REGISTRY);

    // Search the official MCP Registry. The one deliberate outbound call, and only
    // on an explicit user search — never on boot. Soft-fails to [] so the UI degrades.
    if (pathname === '/api/registry/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        return json(res, 200, await searchRegistry(q, { limit, signal: ctrl.signal }));
      } catch (e) {
        process.stderr.write(`[registry] search failed: ${e instanceof Error ? e.message : String(e)}\n`);
        return json(res, 200, []);
      } finally {
        clearTimeout(timer);
      }
    }
    // Popularity scores for ordering the catalog (recommended set first, then by
    // this). Lazy + cached: served from disk while fresh (24h), otherwise fetched
    // now (npm + GitHub, 8s budget) and cached. Only ever hit when the UI opens
    // the catalog — never on boot. Soft-fails to stale cache or {}.
    if (pathname === '/api/registry/popularity' && req.method === 'GET') {
      const cached = loadPopularityCache();
      const fresh = cached && Date.now() - cached.fetchedAt < POPULARITY_TTL && Object.keys(cached.scores).length > 0;
      if (fresh) return json(res, 200, cached!.scores);
      try {
        const scores = await computePopularity();
        if (Object.keys(scores).length > 0) {
          savePopularityCache({ fetchedAt: Date.now(), scores });
          return json(res, 200, scores);
        }
        return json(res, 200, cached?.scores ?? {}); // nothing fetched → stale beats empty
      } catch {
        return json(res, 200, cached?.scores ?? {});
      }
    }

    // CLIs section: which command-line tools are installed (local, no network).
    if (pathname === '/api/clis' && req.method === 'GET') return json(res, 200, await detectClisCached());
    // Ad-hoc "is <name> available?" search. Name is validated to a safe charset
    // and only used for a PATH filename lookup — never passed to a shell.
    if (pathname === '/api/clis/check' && req.method === 'GET') {
      const name = (url.searchParams.get('name') ?? '').trim();
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return json(res, 400, { error: 'invalid command name' });
      const path = resolveOnPath(name);
      const result: CliCheckResult = path
        ? { command: name, found: true, path, version: await probeVersion(path, ['--version']) }
        : { command: name, found: false };
      return json(res, 200, result);
    }

    if (pathname === '/api/gateway') return json(res, 200, gatewayInfo());
    if (pathname === '/api/analytics') {
      const summary = supervisor.analytics();
      if (!store) return json(res, 200, summary);
      // The in-memory series can only see the last EVENT_TAIL calls; the store
      // buckets in SQL, so the 24h chart stays correct however busy the gateway
      // is. Flush first, or calls still sitting in the debounced write queue
      // would be missing from the chart for up to two seconds.
      flushStore();
      return json(res, 200, { ...summary, series: store.hourlySeries(24) });
    }

    // ── durable usage history (the user's own audit trail; never leaves the box) ──
    // Filterable itemised feed backing "management of MCP usage": which tool, by
    // which client, when, how long, how much data, and whether it failed.
    if (pathname === '/api/usage/events' && req.method === 'GET') {
      if (!store) return json(res, 200, []);
      flushStore(); // include calls still sitting in the write queue
      return json(
        res,
        200,
        store.events({
          limit: Number(url.searchParams.get('limit')) || 100,
          serverId: url.searchParams.get('server') ?? undefined,
          client: url.searchParams.get('client') ?? undefined,
          since: url.searchParams.get('since') ?? undefined,
        }),
      );
    }

    // ── desktop/service settings (autostart, start-minimized, close button) ──
    if (pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settingsInfo());
    if (pathname === '/api/settings' && req.method === 'PATCH') {
      try {
        const b = JSON.parse(await readBody(req)) as UpdateSettingsRequest;
        const cur = loadSettings();
        if (typeof b.startMinimized === 'boolean') cur.startMinimized = b.startMinimized;
        if (b.closeAction === 'ask' || b.closeAction === 'tray' || b.closeAction === 'quit') cur.closeAction = b.closeAction;
        // Skipping is per version, and `null` un-skips: the Settings page can
        // always hand back a version the topbar was told to stop offering.
        if (b.skippedUpdate === null) delete cur.skippedUpdate;
        else if (typeof b.skippedUpdate === 'string' && /^[\w.+-]{1,64}$/.test(b.skippedUpdate)) cur.skippedUpdate = b.skippedUpdate;
        if (typeof b.runOnStartup === 'boolean') {
          // Let the OS error surface: "could not write the Run key" is a far
          // better answer than a toggle that silently springs back.
          autostart.set(b.runOnStartup);
          cur.runOnStartup = b.runOnStartup;
        }
        saveSettings(cur);
        return json(res, 200, settingsInfo());
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : 'invalid_json' });
      }
    }

    // ── updates ──────────────────────────────────────────────────────────────
    // GET is free and offline: it reports the cached answer plus what an update
    // would take on this install. The check is the only part that reaches out,
    // and only when asked (the UI asks once when it loads; the cache is a day).
    if (pathname === '/api/update' && req.method === 'GET') return json(res, 200, updateInfo());
    if (pathname === '/api/update/check' && req.method === 'POST') {
      const cached = loadUpdateCache();
      const force = url.searchParams.get('force') === '1';
      // Pressing the button means "tell me": a version skipped earlier is being
      // asked about again, so the skip is spent.
      if (force) {
        const s = loadSettings();
        if (s.skippedUpdate) {
          delete s.skippedUpdate;
          saveSettings(s);
        }
      }
      const fresh = cached && !cached.error && Date.now() - new Date(cached.checkedAt).getTime() < UPDATE_TTL;
      if (fresh && !force) return json(res, 200, updateInfo(cached));
      const result = await fetchLatest();
      // Keep a version we already knew if this attempt failed to find one.
      if (result.error && cached?.latest) result.latest = cached.latest;
      saveUpdateCache(result);
      return json(res, 200, updateInfo(result));
    }
    // How far along a download or install is. Free, offline, and polled while a
    // job runs, so it stays a plain read of in-memory state.
    if (pathname === '/api/update/progress' && req.method === 'GET') return json(res, 200, updater.progress());
    // The outcome of the update that brought this daemon up, reported exactly
    // once: without it, a successful update looks identical to a crash-restart.
    if (pathname === '/api/update/result' && req.method === 'GET')
      return json(res, 200, updater.takeLastResult() ?? { ok: false, version: '', finishedAt: '', error: 'none' });

    // Download without installing. The daemon can do this itself and stay up:
    // nothing it is running from is touched until the install, which is why
    // "download only" is a real option and not just a delayed apply.
    if (pathname === '/api/update/download' && req.method === 'POST') {
      if (!selfOrigin(req)) return json(res, 403, { error: 'cross_origin' });
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const info = updateInfo();
      if (!info.updateAvailable || !info.latest) return json(res, 409, { ok: false, error: 'no update available' });
      // Downloading a package this install could never be replaced with would
      // be busywork, so the same guard that stops the install stops the fetch.
      if (!info.canApply) return json(res, 400, { ok: false, error: info.note ?? 'this install cannot be updated in place' });
      const assets = updateAssets(info.latest);
      if (assets.length === 0)
        return json(res, 400, { ok: false, error: 'the release does not carry an installable package for this platform' });
      // Fire and forget: the caller watches /api/update/progress. A rejection
      // is recorded in that state, so nothing is swallowed.
      void updater.download(info.latest, assets).catch(() => {});
      return json(res, 202, { ok: true, version: info.latest, total: info.downloadSize });
    }

    // Apply it: same guards as /api/shutdown, since this stops the daemon (and
    // the tray) so their files can be replaced. The download happens here (we
    // can report it); the install belongs to the shell, which outlives both the
    // daemon and the tray and puts them back afterwards.
    if (pathname === '/api/update/apply' && req.method === 'POST') {
      if (!selfOrigin(req)) return json(res, 403, { error: 'cross_origin' });
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const info = updateInfo();
      if (!info.updateAvailable || !info.latest) return json(res, 409, { ok: false, error: 'no update available' } as ApplyUpdateResponse);
      if (!info.canApply)
        return json(res, 400, { ok: false, error: info.note ?? 'this install cannot be updated in place' } as ApplyUpdateResponse);
      if (!shell.hasShell())
        return json(res, 500, {
          ok: false,
          error: 'the hypergate shell binary is not available to run the update',
        } as ApplyUpdateResponse);

      const assets = updateAssets(info.latest);
      const version = info.latest;
      // Answer now, work after. A download can take a minute, and the caller
      // watching /api/update/progress learns more than a held-open request
      // would tell it. Nothing staged and nothing to fetch is not an error:
      // the shell falls back to a registry install.
      const go = async (): Promise<void> => {
        if (info.staged !== version && assets.length > 0) await updater.download(version, assets);
        // From here the daemon is on borrowed time: the shell stops it so its
        // files can be replaced.
        updater.installing(version);
        if (!shell.startUpdate()) throw new Error('the hypergate shell binary would not start');
      };
      void go().catch((e: unknown) => {
        // A download failure already sits in the progress state; a shell that
        // refused to start does not, and an install that never begins must not
        // leave the UI spinning on "installing".
        updater.failed(version, e instanceof Error ? e.message : 'the update could not be started');
      });
      return json(res, 202, { ok: true, command: info.command } as ApplyUpdateResponse);
    }

    // ── stop the daemon (the manager UI's Stop button) ───────────────────────
    // Two guards, because this is the one route whose whole job is destructive:
    //   • same-origin (see selfOrigin), so no web page the user happens to visit
    //     can reach in and kill the gateway;
    //   • the MASTER gateway token, because an agent's scoped token can call tools, not
    //     take the runtime down.
    // Everything is stopped in `shutdown()` after the response is flushed, so the
    // UI learns it worked instead of seeing a dropped connection.
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      if (!selfOrigin(req)) return json(res, 403, { error: 'cross_origin' });
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const body: ShutdownResponse = { ok: true, servers: supervisor.ids().length };
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      return res.end(JSON.stringify(body), () => shutdown('requested from the manager UI'));
    }

    // ── connected agents (scoped gateway tokens) ─────────────────────────────
    if (pathname === '/api/clients' && req.method === 'GET') return json(res, 200, clients.map(agentInfo));
    if (pathname === '/api/clients' && req.method === 'POST') {
      try {
        const b = JSON.parse(await readBody(req)) as { name?: string; servers?: unknown; target?: unknown };
        // A known harness names itself; only a custom agent needs a name typed.
        const picked = typeof b.target === 'string' ? connectTarget(b.target) : undefined;
        const name = ((b.name ?? '') || (picked?.name ?? '')).trim();
        if (!name) return json(res, 400, { error: 'name required' });
        const agent: AgentClient = {
          id: `${agentSlug(name)}-${randomBytes(2).toString('hex')}`,
          name,
          token: randomBytes(24).toString('hex'),
          servers: normServers(b.servers),
          createdAt: new Date().toISOString(),
          // Only a target we actually know: the UI shows an official agent's
          // name as unchangeable, so an unrecognised id must not confer that.
          ...(picked ? { target: picked.id } : {}),
        };
        clients.push(agent);
        saveClients(clients);
        return json(res, 200, agentInfo(agent));
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    }
    /**
     * Find one agent from a key that may have outlived its exact id, and
     * optionally create it. This is what `hypergate mcp-headers` calls, which is
     * in turn what a client's headers helper runs at every connection.
     *
     * `create` exists for configuration nobody edits per machine — the Claude
     * Code plugin ships one line naming a key, and the agent it refers to is
     * made here on first use, scoped like the quick-connect button's.
     */
    if (pathname === '/api/clients/resolve' && req.method === 'POST') {
      try {
        const b = JSON.parse(await readBody(req)) as { key?: unknown; create?: unknown };
        const key = typeof b.key === 'string' ? b.key.trim() : '';
        if (!key) return json(res, 400, { error: 'key required' });
        const found = matchAgents(clients, key);
        if (found.length === 1) return json(res, 200, agentInfo(found[0]));
        // Two agents by the same name is the user's to resolve: picking one
        // would hand out a credential on a coin flip.
        if (found.length > 1) return json(res, 409, { error: 'ambiguous', ids: found.map((a) => a.id) });
        if (b.create !== true) return json(res, 404, { error: 'not_found' });
        const picked = connectTarget(agentSlug(key));
        const name = picked?.name ?? agentNameFromKey(key);
        const agent: AgentClient = {
          id: `${agentSlug(name)}-${randomBytes(2).toString('hex')}`,
          name,
          token: randomBytes(24).toString('hex'),
          servers: '*',
          createdAt: new Date().toISOString(),
          ...(picked ? { target: picked.id } : {}),
        };
        clients.push(agent);
        saveClients(clients);
        // `created` so the caller can say a credential was just minted rather
        // than found — the CLI prints that, since silence would be the wrong
        // amount of noise for handing out a new token.
        return json(res, 200, { ...agentInfo(agent), created: true });
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    }
    // Which harnesses this machine has, before any agent exists (the empty-state
    // quick-connect asks for this).
    if (pathname === '/api/connect/targets' && req.method === 'GET') {
      const info: ConnectTargetsInfo = {
        platform: process.platform,
        defaultShell: defaultShellFor(process.platform),
        shells: shellsFor(process.platform),
        targets: await connectTargetsCached(),
      };
      return json(res, 200, info);
    }

    // ── connecting an agent to a harness ─────────────────────────────────────
    const connectM = /^\/api\/clients\/([^/]+)\/connect$/.exec(pathname);
    if (connectM) {
      const agent = clients.find((c) => c.id === connectM[1]);
      if (!agent) return json(res, 404, { error: 'not_found' });
      // GET: the commands + snippets for every client, scoped to this agent.
      if (req.method === 'GET') return json(res, 200, await agentConnectInfo(agent));
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      // POST: run the client's own `mcp add` for the user. The target id only
      // selects a row in the built-in table — the argv is ours, and is spawned
      // without a shell, so nothing from the request reaches a command line.
      try {
        const b = JSON.parse(await readBody(req)) as { target?: string };
        const target = connectTarget(b.target ?? '');
        if (!target || target.method !== 'cli' || !target.command)
          return json(res, 400, { error: 'unknown or non-runnable target' });
        const argv = connectArgv(target.id, {
          url: `http://localhost:${PORT}/mcp`,
          token: agent.token,
          headersHelper: await headersHelperFor(agent),
        });
        if (!argv) return json(res, 400, { error: 'unknown target' });
        const file = resolveOnPath(target.command);
        const command = formatCommand(target.command, argv.add, defaultShellFor(process.platform));
        if (!file) {
          const miss: ConnectResult = {
            ok: false, target: target.id, command, output: '',
            error: `${target.command} isn't on this machine's PATH.`,
          };
          return json(res, 200, miss);
        }
        // Clear a previous `hypergate` entry first so re-connecting (after a
        // token change, say) succeeds instead of erroring on a duplicate name.
        if (argv.reset) await runClientCli(file, argv.reset);
        const run = await runClientCli(file, argv.add);
        const result: ConnectResult = {
          ok: run.ok,
          target: target.id,
          command,
          output: run.output.slice(0, 4000),
          error: run.ok ? undefined : `${target.name} rejected the command.`,
        };
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : 'invalid_json' });
      }
    }

    // Enable or disable ONE server for ONE agent: the per-agent toggles in the
    // UI (both on the agent row and under a server's "Agents" panel).
    //
    // Deliberately not a whole-allow-list PATCH: turning a server off for an
    // agent scoped to `'*'` means writing out the servers that exist *now* minus
    // that one, and only the daemon knows the full roster. A UI computing that
    // from a stale list would silently revoke a server it hadn't heard of yet.
    const permM = /^\/api\/clients\/([^/]+)\/servers\/([^/]+)$/.exec(pathname);
    if (permM && req.method === 'POST') {
      const agent = clients.find((c) => c.id === permM[1]);
      if (!agent) return json(res, 404, { error: 'not_found' });
      const serverId = decodeURIComponent(permM[2]);
      try {
        const b = JSON.parse(await readBody(req)) as SetAgentServerRequest;
        if (typeof b.allowed !== 'boolean') return json(res, 400, { error: 'allowed must be true or false' });
        // Granting access needs a server that exists; revoking never does, because an
        // agent listing a server that was since removed must still be clearable.
        if (b.allowed && !servers.some((s) => s.id === serverId)) return json(res, 404, { error: 'unknown_server' });
        // Mutating the live object is the point: the gateway reads the agent's
        // scope per request, so the next tools/list already reflects this.
        agent.servers = setServerAllowed(
          agent.servers,
          serverId,
          b.allowed,
          servers.map((s) => s.id),
        );
        saveClients(clients);
        return json(res, 200, agentInfo(agent));
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    }

    const clientM = /^\/api\/clients\/([^/]+)$/.exec(pathname);
    if (clientM && req.method === 'PATCH') {
      const agent = clients.find((c) => c.id === clientM[1]);
      if (!agent) return json(res, 404, { error: 'not_found' });
      try {
        const b = JSON.parse(await readBody(req)) as { name?: string; servers?: unknown };
        // An agent created from the catalog is that product: its name is the
        // product's name, and renaming it would leave a "Cursor" row that is
        // Cursor's token but says something else. Permissions stay editable.
        if (typeof b.name === 'string' && b.name.trim()) {
          if (agent.target) return json(res, 409, { error: 'an official agent cannot be renamed' });
          agent.name = b.name.trim();
        }
        if (b.servers !== undefined) agent.servers = normServers(b.servers);
        saveClients(clients);
        return json(res, 200, agentInfo(agent));
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    }
    if (clientM && req.method === 'DELETE') {
      clients = clients.filter((c) => c.id !== clientM[1]);
      saveClients(clients);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/servers' && req.method === 'GET') return json(res, 200, withLastLog(withAccounts(supervisor.list())));

    // add a server (custom config, or a registry entry merged with overrides)
    if (pathname === '/api/servers' && req.method === 'POST') {
      try {
        const cfg = JSON.parse(await readBody(req)) as ManagedServerConfig;
        cfg.runtime = cfg.runtime === 'docker' ? 'docker' : cfg.runtime === 'remote' ? 'remote' : 'process';
        const isRemote = cfg.runtime === 'remote';
        // Remote needs a url; a process server needs a command; a docker server
        // needs an image (its entrypoint runs when no command is given).
        if (!cfg.id || !cfg.name || (isRemote ? !cfg.url : !cfg.command && !cfg.image))
          return json(res, 400, { error: isRemote ? 'id, name, and url required' : 'id, name, and a command or image required' });
        if (servers.some((s) => s.id === cfg.id)) return json(res, 409, { error: 'id_exists' });
        cfg.enabled = cfg.enabled ?? true;
        if (isRemote) {
          cfg.command = cfg.command ?? '';
          cfg.transport = cfg.transport === 'sse' ? 'sse' : 'http';
          cfg.auth = cfg.auth === 'none' ? 'none' : 'oauth';
        }
        servers.push(cfg);
        saveConfig(servers);

        // Remote + OAuth: kick off the browser flow. If tokens already exist
        // (re-add), connect straight away; otherwise return the sign-in URL.
        if (isRemote && cfg.auth === 'oauth') {
          const result = await runOAuth(cfg);
          if (result.authorized) {
            await supervisor.start(cfg);
            return json(res, 200, supervisor.status(cfg.id));
          }
          supervisor.markAuthorizing(cfg);
          return json(res, 200, { ...supervisor.status(cfg.id), authUrl: result.authUrl, error: result.error } as ServerStatus);
        }

        if (cfg.enabled) await supervisor.start(cfg);
        return json(res, 200, supervisor.status(cfg.id) ?? { id: cfg.id, state: 'stopped' });
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    }

    // Server logs. Durable rows survive restarts, so they're preferred; the
    // in-memory ring is the fallback when the store is unavailable. Flushing
    // first means the queue can't hide log lines from the last couple of seconds.
    const logsM = /^\/api\/servers\/([^/]+)\/logs$/.exec(pathname);
    if (logsM && req.method === 'GET') {
      const id = logsM[1];
      const limit = Math.min(10_000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
      if (store) {
        flushStore();
        const rows = store.logs(id, limit);
        if (rows.length) return json(res, 200, { logs: rows.map((l) => l.line), entries: rows });
      }
      return json(res, 200, { logs: supervisor.logs(id) });
    }

    // Remove: everything this server was, gone. Stop it, forget its OAuth
    // grant, drop the config row, and take it out of the agent allow-lists it
    // appears in — so nothing is left pointing at an id that no longer exists,
    // and re-adding it starts from a clean sign-in rather than resurrecting
    // somebody's old grant.
    const rmM = /^\/api\/servers\/([^/]+)$/.exec(pathname);
    if (rmM && req.method === 'DELETE') {
      const id = rmM[1];
      await supervisor.remove(id);
      deleteOAuth(id);
      servers = servers.filter((s) => s.id !== id);
      saveConfig(servers);
      // `'*'` needs no pruning: it means "every server there is", and this one
      // no longer is one.
      let scopesChanged = false;
      for (const agent of clients) {
        if (agent.servers === '*' || !agent.servers.includes(id)) continue;
        agent.servers = agent.servers.filter((s) => s !== id);
        scopesChanged = true;
      }
      if (scopesChanged) saveClients(clients);
      return json(res, 200, { ok: true });
    }

    // (re)start the OAuth login for a remote server — returns { authUrl } to open,
    // or the ready status if tokens already existed and the server connected.
    const authM = /^\/api\/servers\/([^/]+)\/authorize$/.exec(pathname);
    if (authM && req.method === 'POST') {
      const cfg = servers.find((s) => s.id === authM[1]);
      if (!cfg) return json(res, 404, { error: 'not_found' });
      if (cfg.runtime !== 'remote') return json(res, 400, { error: 'not a remote server' });
      cfg.auth = cfg.auth === 'none' ? 'none' : 'oauth';
      const result = await runOAuth(cfg);
      if (result.authorized) {
        cfg.enabled = true;
        saveConfig(servers);
        await supervisor.start(cfg);
        return json(res, 200, supervisor.status(cfg.id));
      }
      supervisor.markAuthorizing(cfg);
      return json(res, 200, { ...supervisor.status(cfg.id), authUrl: result.authUrl, error: result.error } as ServerStatus);
    }

    const m = /^\/api\/servers\/([^/]+)\/(start|stop|restart)$/.exec(pathname);
    if (m && req.method === 'POST') {
      const [, id, action] = m;
      const cfg = servers.find((s) => s.id === id);
      if (!cfg) return json(res, 404, { error: 'not_found' });
      cfg.enabled = action !== 'stop';
      saveConfig(servers);
      if (action === 'stop') await supervisor.stop(id);
      // A remote server that still needs sign-in can't be started by the generic
      // Start/Restart button — surface it as authorizing so the UI prompts login.
      else if (needsAuth(cfg)) supervisor.markAuthorizing(cfg);
      else if (action === 'restart') await supervisor.restart(cfg);
      else await supervisor.start(cfg);
      return json(res, 200, supervisor.status(id));
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    // Anything else is the web UI.
    return serveUi(res, pathname);
  });
  /**
   * Take the daemon down cleanly. Idempotent, because the response callback that
   * triggers it can fire alongside a signal handler.
   *
   * Order matters: stop listening first so nothing new arrives, then stop the
   * managed servers. Their child processes are ours, and exiting without closing
   * them leaks a process tree, which is the very thing `hypergate stop`'s
   * `taskkill /T` has to clean up when the daemon is killed from outside.
   */
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`hypergated stopping: ${reason}\n`);
    server.close();
    void supervisor
      .stopAll()
      .catch(() => {
        /* a server that was already gone must not block the exit */
      })
      .finally(() => {
        flushStore();
        store?.close();
        process.exit(0);
      });
  };

  void booted.then(() =>
    server.listen(PORT, '127.0.0.1', () =>
      process.stdout.write(`hypergated up — UI + API on http://localhost:${PORT} · MCP gateway at /mcp\n`),
    ),
  );
}
