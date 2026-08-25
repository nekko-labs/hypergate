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
  resolveServer,
  planSetup,
  KNOWN_CLIS,
  adviceForCli,
  adviceForServer,
  cliCatalogEntry,
  knownCli,
  matchesCli,
  searchCliCatalog,
  CLI_MANAGERS,
  chooseInstall,
  enrichCliInstalls,
  parseCuratedCommand,
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
  BUILTIN_NS,
  CREDENTIAL_GUIDES,
  credentialEnv,
  isCredentialAllowed,
  isValidEnvVar,
  setCredentialAllowed,
  type GatewayBuiltinTool,
  assetsFromGithub,
  assetsFromNpm,
  detectInstallChannel,
  isNewerVersion,
  latestFromGithub,
  latestFromNpm,
  macosInstallerFromGithub,
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
import { registryConnections } from '@hypergate/shared';
import { openStore } from './store.ts';
import { CredentialVault } from './vault.ts';
import { CredentialRequestStore } from './requests.ts';
import { CliInstallRequestStore } from './cli-requests.ts';
import { CliJobRunner } from './cli-jobs.ts';
import * as shell from './shell.ts';
import * as autostart from './autostart.ts';
import { Updater } from './updater.ts';
import { isAllowedHost, isAllowedMutationRequest } from './security.ts';
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
  CliCatalogEntry,
  CliCheckResult,
  CliJobAction,
  CliManagerInfo,
  StartCliJobRequest,
  OAuthAppInfo,
  ConnectTargetStatus,
  ConnectTargetsInfo,
  AgentConnectInfo,
  ConnectResult,
  SetAgentServerRequest,
  AgentCredentialListing,
  CreateCredentialRequest,
  CredentialGuideInfo,
  CredentialInfo,
  CredentialRequestsResponse,
  DeleteCredentialResponse,
  ResolveCredentialRequestResponse,
  RevealCredentialResponse,
  ResolveCredentialsRequest,
  RollCredentialRequest,
  SetAgentCredentialRequest,
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
 *     (Claude Code, Cursor, Kotrain) can spawn `hypergated --stdio` as ONE
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
const TOKEN_KEY = 'bearerToken';
// `HYPERGATE_PORT` first, because that's what the shell and CLI read: a user who
// sets only `PORT` still works, but one who sets only `HYPERGATE_PORT` would
// otherwise get a daemon on 7777 that the CLI then looks for somewhere else.
const PORT = Number(process.env.HYPERGATE_PORT ?? process.env.PORT ?? 7777);
const LISTEN_HOST = '127.0.0.1';
const VERSION = '1.14.0';
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
const fetchText = async (url: string, signal: AbortSignal): Promise<string | undefined> => {
  const res = await fetch(url, { signal, headers: { 'User-Agent': 'hypergate', Accept: 'text/plain' } });
  if (!res.ok) return undefined;
  return res.text();
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
    const macosApp = installChannel() === 'installer' && process.platform === 'darwin';
    const npmDoc = macosApp ? undefined : await fetchJson(NPM_URL, ctrl.signal).catch(() => undefined);
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
      // The release carries both the npm tarballs and the signed macOS disk
      // images, so each install channel downloads the artifact it can replace.
      const sumsAsset = (ghDoc as { assets?: { name?: string; browser_download_url?: string }[] } | undefined)?.assets?.find(
        (a) => a.name === 'SHA256SUMS',
      );
      const sums = sumsAsset?.browser_download_url
        ? await fetchText(sumsAsset.browser_download_url, ctrl.signal).catch(() => undefined)
        : undefined;
      const assets = isNewerVersion(fromGithub, VERSION)
        ? macosApp
          ? macosInstallerFromGithub(ghDoc, fromGithub, process.arch, sums)
          : assetsFromGithub(ghDoc, fromGithub, process.platform, process.arch, sums)
        : [];
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
    ...(available && channel === 'installer' && process.platform === 'darwin' && assets.length === 0
      ? { canApply: false, note: 'This release does not carry a signed disk image for this Mac.' }
      : {}),
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

/**
 * Looking up a tool you could install (as opposed to detecting one you have).
 *
 * The lookup itself is in core (npm registry + Homebrew formulae — see
 * cli-search.ts for why those two). Here we add the two things only the daemon
 * knows: whether the command is already on this machine, and the verdict on
 * whether it's the tool the vendor actually recommends.
 *
 * `installed` is set to `true` or left absent, never `false`, for a looked-up
 * Homebrew formula: the API doesn't list a formula's executables, so `ripgrep`
 * installing `rg` would otherwise be reported as missing. Curated and npm entries
 * carry a real command, so those can answer both ways.
 */
const annotateCli = async (entry: CliCatalogEntry): Promise<CliCatalogEntry> => {
  const path = resolveOnPath(entry.command);
  const known = path
    ? { installed: true, path, version: await probeVersion(path, entry.versionArgs ?? ['--version']) }
    : entry.channel === 'brew'
      ? {}
      : { installed: false };
  // Lifecycle enrichment: manager ids, mechanical uninstall/repair commands,
  // and the pnpm/yarn/bun equivalents of an npm route (see cli-actions.ts).
  const annotated = { ...enrichCliInstalls(entry), ...known };
  return { ...annotated, advice: adviceForCli(annotated) };
};

const searchClis = async (query: string, limit: number, signal: AbortSignal): Promise<CliCatalogEntry[]> => {
  const found = await searchCliCatalog(query, { limit, signal, platform: process.platform });
  return Promise.all(found.map(annotateCli));
};

/** Curated catalog rows, so the CLI section can offer tools with no search typed. */
const cliCatalog = async (): Promise<CliCatalogEntry[]> =>
  Promise.all(KNOWN_CLIS.map((tool) => annotateCli(cliCatalogEntry(tool, process.platform))));

/**
 * The catalog with its trust verdicts attached. Computed here rather than in the
 * browser so the UI, the CLI and any future surface read the same sentence, and
 * so `@hypergate/core` never has to be bundled into the web app.
 */
const withAdvice = (entries: RegistryEntry[]): RegistryEntry[] =>
  entries.map((entry) => ({ ...entry, advice: adviceForServer(entry) }));

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
    agentsSeeAllCredentialNames: s.agentsSeeAllCredentialNames !== false,
    // Probed rather than assumed: a Mac with no Touch ID sensor and a Linux box
    // with no polkit both need the reveal button disabled with a reason, and
    // only the shell binary can tell us which case we are in.
    authorize: shell.authorizeCapability(),
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

/** Keychain entry name for one server's grant blob. */
const oauthKey = (id: string): string => `oauth:${id}`;
/** Where a registered OAuth app falls back to when there is no keychain. */
const appFile = (id: string): string => join(OAUTH_DIR, `${encodeURIComponent(id)}.app.json`);
/** In-memory cache, so repeated `load()` calls don't each spawn a subprocess. */
const blobCache = new Map<string, Record<string, string>>();
/** Whether the keychain is usable. Probed once; false means stay on files. */
let keychainOk: boolean | undefined;
const useKeychain = (): boolean => {
  // Explicit opt-out, mainly so test daemons on developer machines cannot
  // write scratch secrets into the person's real keychain.
  if (process.env.HYPERGATE_NO_KEYCHAIN === '1') return false;
  if (keychainOk === undefined) keychainOk = shell.hasShell() && shell.keychainAvailable();
  return keychainOk;
};

const readFileBlob = (file: string): Record<string, string> => {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    /* corrupt file → start fresh */
  }
  return {};
};

const readBlob = (key: string, file: string, migrateLabel?: string): Record<string, string> => {
  const cached = blobCache.get(key);
  if (cached) return cached;

  let blob: Record<string, string> = {};
  if (useKeychain()) {
    const raw = shell.secretGet(key);
    if (raw) {
      try {
        blob = JSON.parse(raw) as Record<string, string>;
      } catch {
        /* corrupt entry → start fresh */
      }
    } else if (migrateLabel) {
      // One-time migration: adopt an existing plaintext blob, then delete it.
      const fromFile = readFileBlob(file);
      if (Object.keys(fromFile).length > 0 && shell.secretSet(key, JSON.stringify(fromFile))) {
        blob = fromFile;
        try {
          rmSync(file);
          process.stderr.write(`[oauth] moved ${migrateLabel} into the OS keychain\n`);
        } catch {
          /* best-effort */
        }
      }
    }
  } else {
    blob = readFileBlob(file);
  }
  blobCache.set(key, blob);
  return blob;
};

const writeBlob = (key: string, file: string, blob: Record<string, string>): void => {
  blobCache.set(key, blob);
  if (useKeychain() && shell.secretSet(key, JSON.stringify(blob))) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(blob, null, 2));
};

/** One keychain entry (or file, without a keychain) as a keyed store. */
const secretStoreFor = (key: string, file: string, migrateLabel?: string): OAuthStore => ({
  load: (k) => readBlob(key, file, migrateLabel)[k],
  save: (k, value) => writeBlob(key, file, { ...readBlob(key, file, migrateLabel), [k]: value }),
  remove: (k) => {
    const blob = { ...readBlob(key, file, migrateLabel) };
    delete blob[k];
    writeBlob(key, file, blob);
  },
});

/** A server's OAuth grant: tokens, PKCE state, the cached account. */
const secretStore = (id: string): OAuthStore => secretStoreFor(oauthKey(id), oauthFile(id), `${id} grant`);
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

/**
 * …or registered by the user, in the app.
 *
 * Env vars mean whoever packaged Hypergate has to have registered an app with
 * the provider, and for GitHub nobody has: `github.com/login/oauth` advertises no
 * `registration_endpoint`, so dynamic registration is impossible and sign-in
 * simply failed for every user. Registering an OAuth app takes two minutes in a
 * browser, so the app now walks the user through it once and keeps the result
 * here — in the same keychain entry as that server's grant, never in servers.json.
 */
const K_APP_CLIENT_ID = 'client_id';
const K_APP_CLIENT_SECRET = 'client_secret';
/**
 * The registered app lives in its own keychain entry (`oauth-app:<id>`), not in
 * the server's grant blob, because the two have different lifetimes: removing a
 * server is meant to erase the sign-in (v0.16.1's "Remove is the whole eraser"),
 * while the app is provider configuration the user spent minutes registering at
 * the provider. Sharing the blob meant one Remove, or one rolled-back add, sent
 * them back to GitHub's form to make another one.
 */
const appStore = (id: string): OAuthStore => secretStoreFor(`oauth-app:${id}`, appFile(id));
const storedClientId = (id: string): string | undefined => appStore(id).load(K_APP_CLIENT_ID);
const storedClientSecret = (id: string): string | undefined => appStore(id).load(K_APP_CLIENT_SECRET);
/**
 * The full resolution order for the OAuth flow itself: what the packager set,
 * then what the user registered in the app.
 */
const resolvedClientId = (cfg: ManagedServerConfig): string | undefined =>
  packagerClientId(cfg) || storedClientId(cfg.id);
const resolvedClientSecret = (cfg: ManagedServerConfig): string | undefined =>
  cfg.clientSecret || envKey('HYPERGATE_CLIENTSECRET', cfg.id) || storedClientSecret(cfg.id);
/**
 * Only what a *packager* set, which is the narrower question `usesOAuth` asks.
 *
 * A config/env client id is a deliberate statement that this provider's token
 * entries should really go through OAuth. An app the user registered is not: they
 * may well have set one up and then chosen "API key or token" anyway, and letting
 * the stored app answer here turned that explicit choice into a sign-in the user
 * never asked for, with the pasted token saved and never used.
 */
const packagerClientId = (cfg: ManagedServerConfig): string | undefined =>
  cfg.clientId || envKey('HYPERGATE_CLIENTID', cfg.id);
/**
 * Enough of a credential to recognise it, and never enough to use it. A client id
 * is not a secret, but returning it whole would make the API a way to read one
 * back out of the keychain, which is a habit worth not having.
 */
const maskCredential = (value: string): string =>
  value.length <= 10 ? `${value.slice(0, 2)}…` : `${value.slice(0, 6)}…${value.slice(-4)}`;
/** Where a resolved client id came from, for the setup UI to report honestly. */
const clientIdSource = (cfg: ManagedServerConfig): OAuthAppInfo['source'] =>
  cfg.clientId ? 'config' : envKey('HYPERGATE_CLIENTID', cfg.id) ? 'env' : storedClientId(cfg.id) ? 'keychain' : undefined;
/** Token-auth entries can still use OAuth when the user has supplied an app id. */
const usesOAuth = (cfg: ManagedServerConfig): boolean => cfg.auth === 'oauth' || (cfg.auth === 'token' && !!packagerClientId(cfg));
const storedBearerToken = (cfg: ManagedServerConfig): string | undefined => secretStore(cfg.id).load(TOKEN_KEY);
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
/** A remote server with no usable credential yet needs the user to authenticate. */
const needsAuth = (cfg: ManagedServerConfig): boolean =>
  cfg.runtime === 'remote' &&
  (usesOAuth(cfg) ? !makeProvider(cfg).hasTokens() : cfg.auth === 'token' && !storedBearerToken(cfg));

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
 *
 * The OAuth *app* the user registered at the provider is deliberately not in
 * here: it lives in its own entry (see `appStore`), because it is configuration
 * for the provider rather than part of any one sign-in, and re-registering one is
 * a trip to the provider's website.
 */
const deleteOAuth = (id: string): void => {
  blobCache.delete(oauthKey(id));
  accountProbed.delete(id);
  accountMemo.delete(id);
  if (useKeychain()) shell.secretDelete(oauthKey(id));
  try {
    rmSync(oauthFile(id));
  } catch {
    /* absent is the outcome we wanted anyway */
  }
};

// ── the credential vault ─────────────────────────────────────────────────────
// Named secret values (API keys, access tokens) for CLIs and MCP servers.
// Values live in the OS keychain (`cred:<id>`) with the same file fallback the
// OAuth grants use; metadata lives in ~/.hypergate/credentials.json and never
// carries a value. See vault.ts for the storage rules and the three doors a
// value can leave through.
const vault = new CredentialVault(DATA_DIR, {
  available: () => useKeychain(),
  get: (k) => shell.secretGet(k),
  set: (k, v) => shell.secretSet(k, v),
  delete: (k) => shell.secretDelete(k),
});

/**
 * Pending access requests. See requests.ts for why this is memory rather than a
 * file: a request is worth about as much as the retry loop that produced it.
 */
const credentialRequests = new CredentialRequestStore();

/** Where a user goes to answer one request. Clickable from a terminal. */
const requestUrl = (credentialId: string): string =>
  `http://localhost:${PORT}/#credentials/${encodeURIComponent(credentialId)}/request`;

/**
 * The gateway's own credential tools, built per request with the caller's
 * scope closed over. Master reaches everything; an agent reaches exactly its
 * allow-list (absent = nothing). Calls and refusals are recorded through the
 * normal usage path, so analytics answers "who took which key, when".
 *
 * `asker` is the agent behind the call, present only for agent-scoped callers.
 * It is what lets a refusal become a request: a master caller has nothing to
 * ask for and nobody to ask.
 */
const credentialBuiltins = (
  scope: '*' | string[] | undefined,
  asker?: { id: string; name: string },
): GatewayBuiltinTool[] => {
  /**
   * File a request, if there is anyone to file it as. Returns the URL to hand
   * the user, or undefined when the caller is master (which cannot be refused,
   * so never reaches here) or when the credential does not exist.
   */
  const fileRequest = (credentialId: string, credentialName: string, reason?: string): string | undefined => {
    if (!asker) return undefined;
    credentialRequests.file({
      credentialId,
      credentialName,
      agentId: asker.id,
      agentName: asker.name,
      reason,
    });
    return requestUrl(credentialId);
  };

  return [
    {
      name: 'credentials_list',
      description:
        'List the vault credentials on this machine: metadata only (id, name, env var), never values. Rows with "allowed": true can be fetched with credential_env; rows with "allowed": false need the user to approve access first, via credential_request.',
      inputSchema: { type: 'object', properties: {} },
      call: (): AgentCredentialListing[] => {
        // The opacity switch. On (the default) an agent sees every name so it
        // can ask for one by id; off restores v1.7.0, where a credential it was
        // not granted does not exist as far as it can tell.
        const showAll = loadSettings().agentsSeeAllCredentialNames !== false;
        const rows: AgentCredentialListing[] = [];
        for (const r of vault.list()) {
          const allowed = scope === '*' || isCredentialAllowed(scope, r.id);
          if (!allowed && (!showAll || !asker)) continue;
          rows.push({
            id: r.id,
            name: r.name,
            kind: r.kind,
            service: r.service,
            envVar: r.envVar,
            allowed,
            rotatedAt: r.rotatedAt,
            // No hint on an unpermitted row: a masked value is still four
            // characters of a secret the caller was not granted.
            ...(allowed ? {} : { requestUrl: requestUrl(r.id) }),
          });
        }
        return rows;
      },
    },
    {
      name: 'credential_env',
      description:
        'Fetch one allowed credential as environment variables. Returns {env: {VAR: value, …}, value}. Set the env on the process that needs the key (e.g. before re-running a CLI) instead of asking the user to re-authenticate by hand. If access has not been granted, this files a request and tells you the URL to give the user.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Credential id, from credentials_list' } },
        required: ['id'],
      },
      call: (args) => {
        const id = String(args.id ?? '').trim();
        const row = vault.get(id);
        if (!row) throw new Error(`Unknown credential "${id}". Use credentials_list to see what exists.`);
        if (scope !== '*' && !isCredentialAllowed(scope, id)) {
          // The refusal files the request itself, so an agent that never
          // thought to call credential_request still ends up with something
          // the user can act on rather than a dead end.
          const url = fileRequest(id, row.name);
          throw new Error(
            url
              ? `Not permitted: this client may not fetch credential "${id}". A request has been filed. Ask the user to approve it at ${url}, then try again.`
              : `Not permitted: this client may not fetch credential "${id}". The user can grant it in Hypergate.`,
          );
        }
        const value = vault.value(id);
        if (value === undefined) throw new Error(`Credential "${id}" has no stored value. Roll it in Hypergate.`);
        vault.touch(id);
        return { id, envVar: row.envVar, env: credentialEnv(row, value), value };
      },
    },
    {
      name: 'credential_request',
      description:
        'Ask the user for access to a credential this client may not fetch. Returns a URL to give the user so they can approve it. Filing a request grants nothing by itself; retry credential_env once the user approves.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Credential id, from credentials_list' },
          reason: {
            type: 'string',
            description: 'One short line on what the key is for. Shown to the user beside the request.',
          },
        },
        required: ['id'],
      },
      call: (args) => {
        const id = String(args.id ?? '').trim();
        const reason = typeof args.reason === 'string' ? args.reason.slice(0, 200) : undefined;
        const row = vault.get(id);
        if (!row) throw new Error(`Unknown credential "${id}". Use credentials_list to see what exists.`);
        // Already granted: say so rather than filing a request the user would
        // open to find nothing to decide.
        if (scope === '*' || isCredentialAllowed(scope, id))
          return { filed: false, allowed: true, message: `Access to "${id}" is already granted. Call credential_env.` };
        const url = fileRequest(id, row.name, reason);
        if (!url) throw new Error('Only a connected agent can request credential access.');
        return {
          filed: true,
          allowed: false,
          url,
          message: `Ask the user to approve access to "${row.name}" at ${url}, then call credential_env again.`,
        };
      },
    },
  ];
};

// ── CLI lifecycle: jobs the daemon runs, and installs agents may request ─────

/**
 * Lifecycle jobs (install / uninstall / repair / reauth). Finishing one clears
 * the detection memo, so the installed list reflects the change on its next
 * poll instead of ten seconds later.
 */
const cliJobs = new CliJobRunner(() => {
  cliMemo = undefined;
  connectMemo = undefined;
});

/** Pending agent install requests: same memory-not-file reasoning as requests.ts. */
const cliInstallRequests = new CliInstallRequestStore();

/** Where a user goes to answer CLI install requests. Clickable from a terminal. */
const cliRequestUrl = (): string => `http://localhost:${PORT}/#cli/requests`;

/** A safe npm package / Homebrew formula name (the same shape cli-search accepts). */
const SAFE_CLI_PACKAGE = /^[@a-zA-Z0-9._/-]{1,214}$/;

/**
 * Turn a job request into the argv the runner may spawn. The command is always
 * assembled here from catalog data (curated entries, or a validated package
 * name in a fixed template) and re-checked against the curated-launcher
 * grammar; nothing from the request body ever reaches a command line as text.
 */
const deriveCliJob = async (
  input: StartCliJobRequest,
): Promise<{ cliId: string; name: string; action: CliJobAction; argv: string[]; command: string } | { error: string; status: number }> => {
  const action = input.action;
  if (!['install', 'uninstall', 'repair', 'reauth'].includes(action)) return { error: 'unknown action', status: 400 };

  let entry: CliCatalogEntry | undefined;
  if (input.cliId) {
    const tool = knownCli(String(input.cliId));
    if (tool) entry = enrichCliInstalls(cliCatalogEntry(tool, process.platform));
  }
  if (!entry && input.package && (input.channel === 'npm' || input.channel === 'brew')) {
    const pkg = String(input.package);
    if (!SAFE_CLI_PACKAGE.test(pkg)) return { error: 'invalid package name', status: 400 };
    const install =
      input.channel === 'npm'
        ? { label: 'npm', command: `npm install -g ${pkg}@latest` }
        : { label: 'Homebrew', command: `brew install ${pkg}` };
    entry = enrichCliInstalls({
      id: pkg,
      name: pkg,
      command: pkg,
      description: '',
      category: 'other',
      channel: input.channel,
      package: pkg,
      installs: [install],
    });
  }
  if (!entry) return { error: 'unknown tool: pass a curated cliId, or channel + package', status: 404 };

  if (action === 'reauth') {
    const auth = entry.auth;
    if (!auth) return { error: `${entry.name} has no known sign-in command`, status: 400 };
    if (!auth.runnable) {
      return { error: auth.note ?? `${auth.command} needs an interactive terminal; run it yourself`, status: 409 };
    }
    const argv = auth.command.trim().split(/\s+/);
    // The command is curated data, but hold it to its own grammar anyway: it
    // must invoke this tool's binary with plain word arguments.
    if (argv[0] !== entry.command || argv.some((w) => !/^[a-zA-Z0-9._=-]+$/.test(w)))
      return { error: 'malformed auth command', status: 500 };
    const file = resolveOnPath(entry.command);
    if (!file) return { error: `${entry.command} is not installed`, status: 409 };
    return { cliId: entry.id, name: entry.name, action, argv: [file, ...argv.slice(1)], command: auth.command };
  }

  const route = chooseInstall(entry, input.manager);
  if (!route) {
    return {
      error: input.manager
        ? `no runnable ${input.manager} route for ${entry.name} on this platform`
        : `${entry.name} has no install route Hypergate can run; use the copyable command instead`,
      status: 409,
    };
  }
  const command = action === 'uninstall' ? route.uninstall : action === 'repair' ? (route.repair ?? route.command) : route.command;
  if (!command) return { error: `no ${action} command for the ${route.label} route`, status: 409 };
  const argv = parseCuratedCommand(command);
  if (!argv) return { error: `the ${route.label} route is not runnable in-app`, status: 409 };
  return { cliId: entry.id, name: entry.name, action, argv, command };
};

/**
 * The gateway's own CLI tools: every caller may look, and any *agent* may ask
 * for an install; only the user, in the manager, approves and runs one. The
 * master token's owner is the user, who has the UI and `hypergate cli install`,
 * so master callers are told to use those rather than given a request queue to
 * talk to themselves through.
 */
const cliBuiltins = (asker?: { id: string; name: string }): GatewayBuiltinTool[] => [
  {
    name: 'clis_list',
    description:
      'List the command-line tools Hypergate manages on this machine, with version and path when installed. Pass "query" to also search the installable catalog (npm registry + Homebrew formulae) for tools to add. Check here before installing a CLI some other way or asking the user to.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional: search the catalog for tools to install.' } },
    },
    call: async (args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const installed = (await detectClisCached()).map((c) => ({
        id: c.id,
        name: c.name,
        command: c.command,
        installed: c.found,
        version: c.version,
        path: c.path,
        description: c.description,
      }));
      if (!query) return { clis: installed };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const found = await searchClis(query, 8, ctrl.signal);
        return {
          clis: installed,
          catalog: found.map((e) => ({
            id: e.id,
            name: e.name,
            command: e.command,
            channel: e.channel,
            package: e.package,
            installed: e.installed ?? false,
            official: e.official,
            description: e.description,
          })),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    name: 'cli_install_request',
    description:
      'Ask the user to install a command-line tool through Hypergate. Pass a curated id from clis_list, or channel ("npm" | "brew") plus package for anything else, and a short reason. Returns a URL to give the user; approving runs the install in Hypergate with a visible log. Filing installs nothing by itself; call clis_list again after approval to see the tool land.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Curated tool id, from clis_list' },
        channel: { type: 'string', enum: ['npm', 'brew'], description: 'For non-curated tools: which catalog the package lives in' },
        package: { type: 'string', description: 'For non-curated tools: the npm package or Homebrew formula' },
        reason: { type: 'string', description: 'One short line on why the tool is needed. Shown to the user.' },
      },
    },
    call: async (args) => {
      if (!asker) throw new Error('Only a connected agent can request a CLI install. You hold the master token: run the install from the manager, or with `hypergate cli install <id>`.');
      const reason = typeof args.reason === 'string' ? args.reason.slice(0, 200) : undefined;
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const pkg = typeof args.package === 'string' ? args.package.trim() : '';
      const channel = args.channel === 'npm' || args.channel === 'brew' ? args.channel : undefined;
      const tool = id ? knownCli(id) : undefined;
      if (!tool && !(pkg && channel)) {
        throw new Error('Name the tool: a curated id from clis_list, or channel ("npm" | "brew") plus package.');
      }
      if (!tool && !SAFE_CLI_PACKAGE.test(pkg)) throw new Error(`"${pkg}" is not a valid package name.`);
      if (tool) {
        const status = (await detectClisCached()).find((c) => c.id === tool.id);
        if (status?.found)
          return { filed: false, installed: true, message: `${tool.name} is already installed (${status.version ?? 'version unknown'}).` };
      }
      const row = cliInstallRequests.file({
        cliId: tool?.id ?? pkg,
        cliName: tool?.name ?? pkg,
        channel: tool ? undefined : channel,
        package: tool ? undefined : pkg,
        agentId: asker.id,
        agentName: asker.name,
        reason,
      });
      const url = cliRequestUrl();
      return {
        filed: true,
        id: row.id,
        url,
        message: `Ask the user to approve installing ${row.cliName} at ${url}. Hypergate will run the install and show them the log; call clis_list afterwards to confirm.`,
      };
    },
  },
];

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
    const effective = { ...s, auth: usesOAuth(cfg) ? 'oauth' : cfg.auth };
    const signedIn = makeProvider(cfg).hasTokens();
    if (!signedIn) return effective;
    const account = accountFromGrant(cfg);
    if (account) return { ...effective, signedIn, account };
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
    return { ...effective, signedIn };
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
  authProviderFor: (cfg) => (cfg.runtime === 'remote' && usesOAuth(cfg) ? makeProvider(cfg) : undefined),
  // Keep bearer credentials in the daemon's keychain/file store; core only sees
  // the short-lived header needed to connect and never persists or logs it.
  authHeadersFor: (cfg) => {
    if (cfg.runtime !== 'remote' || cfg.auth !== 'token' || usesOAuth(cfg)) return undefined;
    const token = storedBearerToken(cfg);
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  },
  // Enforces per-server resource limits by spawning through `hypergate
  // sandbox-exec`. Undefined when the shell is not installed, in which case a
  // limited server starts unsandboxed and says so in its logs.
  launcher: shell.shellBin(),
  // Resolve a config's credentialRefs (ENV_VAR → credential id) from the vault
  // at spawn time, so servers.json holds references and rolling a credential
  // re-keys the server on its next (re)start. A ref whose credential is gone
  // simply resolves to nothing; the server starts without it and fails with the
  // provider's own error, which names the missing var better than we could.
  secretsFor: (cfg) => {
    const out: Record<string, string> = {};
    for (const [envName, credId] of Object.entries(cfg.credentialRefs ?? {})) {
      if (!isValidEnvVar(envName)) continue;
      const value = vault.value(credId);
      if (value === undefined) continue;
      out[envName] = value;
      vault.touch(credId);
    }
    return out;
  },
});
let servers = loadConfig();
const statusFor = (cfg: ManagedServerConfig): ServerStatus | undefined => {
  const status = supervisor.status(cfg.id);
  if (!status || cfg.runtime !== 'remote') return status;
  return { ...status, auth: usesOAuth(cfg) ? 'oauth' : cfg.auth };
};

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
    if (needsAuth(s)) {
      const error = s.auth === 'token' && !usesOAuth(s) ? `Paste a ${s.name} access token to connect.` : undefined;
      supervisor.markAuthorizing(s, error);
    }
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
    // Answer with what the user can do about it, in the app, rather than with the
    // env vars a packager would use.
    if (/dynamic client registration/i.test(msg) && !resolvedClientId(cfg))
      msg = `${cfg.name} doesn't register apps automatically, so browser sign-in needs a one-time OAuth app. Set one up in Hypergate (it takes a couple of minutes and uses the callback ${OAUTH_REDIRECT}), or connect with a token instead.`;
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
    const gateway = createGateway(
      supervisor,
      { name: 'hypergate-gateway', version: VERSION },
      // A local stdio spawn is the user's own process: master-equivalent scope.
      { caller: 'stdio (local)', builtins: [...credentialBuiltins('*'), ...cliBuiltins()] },
    );
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

  // Start managed servers in the background while the human-facing supervisor
  // becomes available immediately. The UI must show servers transitioning to
  // running instead of withholding itself until every server is ready.
  let bootComplete = false;
  const booted = startEnabled()
    .then(() => {
      bootComplete = true;
    })
    .catch((error) => {
      bootComplete = true;
      process.stderr.write(`[boot] managed server startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  const TOKEN = process.env.HYPERGATE_TOKEN ?? loadToken();
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
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
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_host' }));
    }
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const { pathname } = url;
    if (req.method === 'OPTIONS') {
      if (pathname === '/mcp') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
        });
      } else {
        res.writeHead(204);
      }
      return res.end();
    }
    if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method ?? '') && !isAllowedMutationRequest(req.headers)) {
      return json(res, 403, { error: 'cross_origin' });
    }

    // ── the aggregated MCP endpoint (streamable HTTP, stateless) ──────────
    if (pathname === '/mcp') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');
      const scope = authScope(req);
      if (!scope) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      try {
        await booted;
        const body = JSON.parse(await readBody(req));
        let caller: string;
        let allowServer: ((id: string) => boolean) | undefined;
        let credScope: '*' | string[] | undefined;
        // Who to file an access request as. Agent-scoped callers only: a master
        // caller is never refused, so it has nothing to request.
        let asker: { id: string; name: string } | undefined;
        if (scope.kind === 'agent') {
          caller = scope.agent.name;
          const allow = scope.agent.servers;
          allowServer = (id) => allow === '*' || allow.includes(id);
          // Credentials are deny-by-default: an agent with no allow-list gets none.
          credScope = scope.agent.credentials;
          asker = { id: scope.agent.id, name: scope.agent.name };
          scope.agent.lastUsed = new Date().toISOString();
          persistClients();
        } else {
          caller = callerFor(req, body);
          credScope = '*';
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const gateway = createGateway(
          supervisor,
          { name: 'hypergate-gateway', version: VERSION },
          { caller, allowServer, builtins: [...credentialBuiltins(credScope, asker), ...cliBuiltins(asker)] },
        );
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

    if (pathname === '/health')
      return json(res, 200, {
        ok: true,
        service: 'hypergated',
        version: VERSION,
        servers: supervisor.list().length,
        bootComplete,
      });
    if (pathname === '/api/registry') return json(res, 200, withAdvice(REGISTRY));

    // Search the official MCP Registry. The one deliberate outbound call, and only
    // on an explicit user search — never on boot. Soft-fails to [] so the UI degrades.
    if (pathname === '/api/registry/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        return json(res, 200, withAdvice(await searchRegistry(q, { limit, signal: ctrl.signal })));
      } catch (e) {
        process.stderr.write(`[registry] search failed: ${e instanceof Error ? e.message : String(e)}\n`);
        return json(res, 200, []);
      } finally {
        clearTimeout(timer);
      }
    }
    // Resolve one name to one pinned, ready-to-add server, plus everything
    // standing between it and running. Two outbound calls (the name lookup and
    // that server's version history), on an explicit request only. This is what
    // lets an agent or the CLI say "set up com.microsoft/azure" and get back a
    // concrete plan instead of a catalog page.
    if (pathname === '/api/registry/resolve' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      if (!q.trim()) return json(res, 400, { error: 'q required' });
      const allowPrerelease = url.searchParams.get('prerelease') === '1';
      const ctrl = new AbortController();
      // Longer than the 8s the catalog search gets, because this is a different
      // kind of request: it is an explicit "set this one up", not a keystroke,
      // and failing it is worse than making it wait. The registry's `?search=`
      // was measured between 0.9s and 24s for the *same* query, and the fallback
      // path spends one of those before it even asks for the version history.
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const resolved = await resolveServer(q, { signal: ctrl.signal, allowPrerelease });
        if (!resolved.ok) return json(res, 404, resolved);
        // What this machine already has, so the plan only asks for what is missing.
        const installedCommands = (await detectClisCached()).filter((c) => c.found).map((c) => c.command);
        const storedCredentials = vault
          .list()
          .filter((c) => c.envVar)
          .map((c) => ({ envVar: c.envVar as string, id: c.id }));
        const entry = { ...resolved.entry, advice: adviceForServer(resolved.entry) };
        return json(res, 200, { ...resolved, entry, plan: planSetup(entry, { installedCommands, storedCredentials }) });
      } catch (e) {
        process.stderr.write(`[registry] resolve failed: ${e instanceof Error ? e.message : String(e)}\n`);
        return json(res, 502, { error: 'resolve_failed' });
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
    // The curated CLI catalog with install routes for this platform. Local too:
    // the rows are built in, only `/api/clis/search` reaches out.
    if (pathname === '/api/clis/catalog' && req.method === 'GET') return json(res, 200, await cliCatalog());
    // Look up an installable CLI. The second deliberate outbound search (after the
    // MCP registry), on the same terms: only when the user types, bounded, and
    // soft-failing to the curated matches so the section still answers offline.
    if (pathname === '/api/clis/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) return json(res, 200, []);
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 6));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        return json(res, 200, await searchClis(q, limit, ctrl.signal));
      } catch (e) {
        process.stderr.write(`[clis] search failed: ${e instanceof Error ? e.message : String(e)}\n`);
        const curated = await Promise.all(
          KNOWN_CLIS.filter((tool) => matchesCli(tool, q)).map((tool) => annotateCli(cliCatalogEntry(tool, process.platform))),
        );
        return json(res, 200, curated);
      } finally {
        clearTimeout(timer);
      }
    }
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
    // Which package managers this machine has, so the UI can offer real choices
    // (an install picker showing brew on a machine without brew is a dead end).
    if (pathname === '/api/clis/managers' && req.method === 'GET') {
      const managers: CliManagerInfo[] = CLI_MANAGERS.filter(
        (m) => !m.platforms || m.platforms.includes(process.platform),
      ).map((m) => ({ id: m.id, label: m.label, command: m.command, found: !!resolveOnPath(m.command) }));
      return json(res, 200, managers);
    }
    // CLI lifecycle jobs: install / uninstall / repair / reauth, run by the
    // daemon with output captured for the UI. Reads are open like the rest of
    // /api/clis; starting or killing one is master-only, like the updater.
    if (pathname === '/api/clis/jobs' && req.method === 'GET') return json(res, 200, cliJobs.list());
    if (pathname === '/api/clis/jobs' && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      let body: StartCliJobRequest;
      try {
        body = JSON.parse(await readBody(req)) as StartCliJobRequest;
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const derived = await deriveCliJob(body);
      if ('error' in derived) return json(res, derived.status, { error: derived.error });
      try {
        return json(res, 202, cliJobs.start(derived));
      } catch (e) {
        return json(res, 409, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const cliJobM = /^\/api\/clis\/jobs\/([^/]+)$/.exec(pathname);
    if (cliJobM && req.method === 'GET') {
      const job = cliJobs.get(decodeURIComponent(cliJobM[1]));
      return job ? json(res, 200, job) : json(res, 404, { error: 'no such job' });
    }
    const cliJobKillM = /^\/api\/clis\/jobs\/([^/]+)\/kill$/.exec(pathname);
    if (cliJobKillM && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const stopped = cliJobs.kill(decodeURIComponent(cliJobKillM[1]));
      return stopped ? json(res, 200, { stopped: true }) : json(res, 404, { error: 'no running job by that id' });
    }
    // Agent install requests. Reading is open (it names tools, not secrets);
    // answering is master-only, and approving is what actually runs the install.
    if (pathname === '/api/cli-requests' && req.method === 'GET')
      return json(res, 200, { requests: cliInstallRequests.list() });
    const cliReqM = /^\/api\/cli-requests\/([^/]+)\/(approve|deny)$/.exec(pathname);
    if (cliReqM && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const request = cliInstallRequests.get(decodeURIComponent(cliReqM[1]));
      if (!request) return json(res, 404, { error: 'no such request (it may have expired)' });
      if (cliReqM[2] === 'deny') {
        cliInstallRequests.resolve(request.id);
        return json(res, 200, { request, approved: false });
      }
      const derived = await deriveCliJob({
        action: 'install',
        cliId: request.channel ? undefined : request.cliId,
        channel: request.channel,
        package: request.package,
      });
      if ('error' in derived) return json(res, derived.status, { error: derived.error });
      try {
        const job = cliJobs.start(derived);
        // Resolved only once the job actually started, so a 409 (another job
        // running) leaves the request answerable rather than silently eaten.
        cliInstallRequests.resolve(request.id);
        return json(res, 202, { request, approved: true, job });
      } catch (e) {
        return json(res, 409, { error: e instanceof Error ? e.message : String(e) });
      }
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
        if (typeof b.agentsSeeAllCredentialNames === 'boolean')
          cur.agentsSeeAllCredentialNames = b.agentsSeeAllCredentialNames;
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
        if (!shell.startUpdate((error) => updater.failed(version, error))) {
          throw new Error('the hypergate shell binary would not start');
        }
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
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const body: ShutdownResponse = { ok: true, servers: supervisor.ids().length };
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      return res.end(JSON.stringify(body), () => shutdown('requested from the manager UI'));
    }

    // ── connected agents (scoped gateway tokens) ─────────────────────────────
    // ── the credential vault ──────────────────────────────────────────────
    // Reads return metadata + masked hints only. Mutations need the master
    // token on top of the global same-origin guard (the /api/shutdown and
    // /api/oauth/app precedent): creating, rolling, deleting, or granting a
    // key must not be reachable by any local page that guesses the shape.
    const credentialInfo = (r: ReturnType<CredentialVault['list']>[number]): CredentialInfo => ({
      ...r,
      storage: vault.storage(),
      usedBy: {
        servers: servers.filter((s) => Object.values(s.credentialRefs ?? {}).includes(r.id)).map((s) => s.id),
        agents: clients.filter((c) => isCredentialAllowed(c.credentials, r.id)).map((c) => c.id),
      },
    });

    if (pathname === '/api/credentials' && req.method === 'GET') return json(res, 200, vault.list().map(credentialInfo));

    // The guides: where each service's credential comes from, plus whether one
    // is already stored. Static data joined with the vault — never a fetch.
    if (pathname === '/api/credentials/guides' && req.method === 'GET') {
      const guides: CredentialGuideInfo[] = CREDENTIAL_GUIDES.map((g) => ({
        ...g,
        storedId: vault.forService(g.service)?.id,
      }));
      return json(res, 200, guides);
    }

    if (pathname === '/api/credentials' && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      try {
        const body = JSON.parse(await readBody(req)) as CreateCredentialRequest;
        const meta = vault.create(body);
        return json(res, 200, credentialInfo(meta));
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : 'invalid_json' });
      }
    }

    // Resolve credentials into env — the `hypergate run` door. Master reaches
    // everything (optionally narrowed to one agent's scope for attribution);
    // an agent token reaches exactly its allow-list. Recorded like a gateway
    // call so analytics shows CLI fetches beside agent fetches.
    if (pathname === '/api/credentials/resolve' && req.method === 'POST') {
      const scope = authScope(req);
      if (!scope) return json(res, 401, { error: 'unauthorized' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}') as ResolveCredentialsRequest;
        let credScope: '*' | string[] | undefined;
        let caller: string;
        if (scope.kind === 'master') {
          if (body.agent) {
            const found = matchAgents(clients, body.agent);
            if (found.length !== 1) return json(res, found.length ? 409 : 404, { error: found.length ? 'ambiguous_agent' : 'unknown_agent' });
            credScope = found[0].credentials;
            caller = found[0].name;
          } else {
            credScope = '*';
            caller = 'hypergate run';
          }
        } else {
          if (body.agent) return json(res, 403, { error: 'only the master token may resolve as another agent' });
          credScope = scope.agent.credentials;
          caller = scope.agent.name;
        }
        const allowedIds = vault.ids().filter((id) => credScope === '*' || isCredentialAllowed(credScope, id));
        let wanted = allowedIds;
        if (Array.isArray(body.ids) && body.ids.length) {
          const denied = body.ids.find((id) => !allowedIds.includes(id));
          if (denied !== undefined) return json(res, 403, { error: `not permitted: ${denied}` });
          wanted = body.ids;
        }
        const { env, used } = vault.envFor(wanted);
        if (used.length) {
          supervisor.record({
            at: new Date().toISOString(),
            serverId: BUILTIN_NS,
            server: 'Hypergate',
            tool: 'credential_env',
            client: caller,
            ok: true,
            ms: 0,
            bytesIn: 0,
            bytesOut: 0,
          });
        }
        return json(res, 200, { env, used });
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    }

    const credRollM = /^\/api\/credentials\/([^/]+)\/roll$/.exec(pathname);
    if (credRollM && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      try {
        const body = JSON.parse(await readBody(req)) as RollCredentialRequest;
        const meta = vault.roll(decodeURIComponent(credRollM[1]), body.value);
        if (!meta) return json(res, 404, { error: 'not_found' });
        // A roll should be complete in one step: every running server that
        // references this credential restarts onto the new value now, instead
        // of failing with the revoked one at some later, surprising moment.
        const restarted: string[] = [];
        for (const cfg of servers) {
          if (!Object.values(cfg.credentialRefs ?? {}).includes(meta.id)) continue;
          if (supervisor.status(cfg.id)?.state === 'ready') {
            await supervisor.restart(cfg);
            restarted.push(cfg.id);
          }
        }
        return json(res, 200, { ...credentialInfo(meta), restarted });
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : 'invalid_json' });
      }
    }

    const credM = /^\/api\/credentials\/([^/]+)$/.exec(pathname);
    if (credM && req.method === 'DELETE') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const id = decodeURIComponent(credM[1]);
      if (!vault.delete(id)) return json(res, 404, { error: 'not_found' });
      // Delete means deleted (the v0.16.1 rule): the value, the metadata, every
      // agent grant, every server reference, and every pending request go
      // together. A dangling ref would resurrect the key the moment someone
      // re-created the id, and a surviving request would offer to grant access
      // to something that no longer exists.
      credentialRequests.forgetCredential(id);
      const prunedAgents: string[] = [];
      for (const c of clients) {
        if (!isCredentialAllowed(c.credentials, id)) continue;
        c.credentials = setCredentialAllowed(c.credentials, id, false, vault.ids());
        prunedAgents.push(c.id);
      }
      if (prunedAgents.length) saveClients(clients);
      const prunedServers: string[] = [];
      for (const cfg of servers) {
        const refs = cfg.credentialRefs ?? {};
        const keys = Object.keys(refs).filter((k) => refs[k] === id);
        if (!keys.length) continue;
        for (const k of keys) delete refs[k];
        if (!Object.keys(refs).length) delete cfg.credentialRefs;
        prunedServers.push(cfg.id);
      }
      if (prunedServers.length) saveConfig(servers);
      const out: DeleteCredentialResponse = { ok: true, servers: prunedServers, agents: prunedAgents };
      return json(res, 200, out);
    }

    // ── pending access requests ─────────────────────────────────────────────
    // What an agent's refusal turns into. Reads are unauthenticated like the
    // rest of the management GETs (localhost, and a request names no secret);
    // answering one is a grant, so it needs the master token like every other
    // vault mutation.
    if (pathname === '/api/credential-requests' && req.method === 'GET') {
      const out: CredentialRequestsResponse = { requests: credentialRequests.list() };
      return json(res, 200, out);
    }

    const credReqM = /^\/api\/credential-requests\/([^/]+)\/(approve|deny)$/.exec(pathname);
    if (credReqM && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const request = credentialRequests.get(decodeURIComponent(credReqM[1]));
      if (!request) return json(res, 404, { error: 'not_found' });
      const approve = credReqM[2] === 'approve';
      let granted = false;
      if (approve) {
        const agent = clients.find((c) => c.id === request.agentId);
        // The agent or the credential can disappear between asking and
        // answering. Resolve the request either way: it is stale, and leaving
        // it pending would offer a decision that cannot be carried out.
        if (agent && vault.get(request.credentialId)) {
          // The same arithmetic the per-agent switch uses. Approving is not a
          // second kind of permission, it is the ordinary grant.
          agent.credentials = setCredentialAllowed(agent.credentials, request.credentialId, true, vault.ids());
          saveClients(clients);
          granted = true;
        }
      }
      credentialRequests.resolve(request.id);
      const out: ResolveCredentialRequestResponse = { ok: true, granted };
      return json(res, 200, out);
    }

    // ── reveal: the fourth door ─────────────────────────────────────────────
    // The only door that hands a value back to the *person* rather than to a
    // process, and the only one that requires proof of who is at the keyboard:
    // master token, same-origin (the global guard above), and a live OS consent
    // prompt. `hypergate authorize` is what makes the last one real: the daemon
    // cannot approve on the user's behalf, it can only ask the OS and be told.
    const credRevealM = /^\/api\/credentials\/([^/]+)\/reveal$/.exec(pathname);
    if (credRevealM && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const id = decodeURIComponent(credRevealM[1]);
      const row = vault.get(id);
      if (!row) return json(res, 404, { error: 'not_found' });
      const verdict = await shell.authorize(`reveal ${row.name}`);
      if (!verdict.authorized) {
        const out: RevealCredentialResponse = {
          ok: false,
          authorized: false,
          reason: verdict.reason,
          detail: verdict.detail,
        };
        // A refusal is recorded too: "someone tried and was denied" is the more
        // interesting half of an audit trail.
        supervisor.record({
          at: new Date().toISOString(),
          serverId: BUILTIN_NS,
          server: 'Hypergate',
          tool: 'credential_reveal',
          client: 'manager UI',
          ok: false,
          ms: 0,
          bytesIn: 0,
          bytesOut: 0,
          error: verdict.reason,
        });
        return json(res, verdict.reason === 'unavailable' ? 501 : 403, out);
      }
      const value = vault.value(id);
      if (value === undefined) return json(res, 404, { error: 'no_value' });
      supervisor.record({
        at: new Date().toISOString(),
        serverId: BUILTIN_NS,
        server: 'Hypergate',
        tool: 'credential_reveal',
        client: 'manager UI',
        ok: true,
        ms: 0,
        bytesIn: 0,
        bytesOut: 0,
      });
      const out: RevealCredentialResponse = { ok: true, authorized: true, value };
      return json(res, 200, out);
    }

    // Enable or disable ONE credential for ONE agent — the mirror of the
    // per-server flip below, with the opposite default (absent scope = none).
    const credPermM = /^\/api\/clients\/([^/]+)\/credentials\/([^/]+)$/.exec(pathname);
    if (credPermM && req.method === 'POST') {
      if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      const agent = clients.find((c) => c.id === credPermM[1]);
      if (!agent) return json(res, 404, { error: 'not_found' });
      const credId = decodeURIComponent(credPermM[2]);
      try {
        const b = JSON.parse(await readBody(req)) as SetAgentCredentialRequest;
        if (typeof b.allowed !== 'boolean') return json(res, 400, { error: 'allowed must be true or false' });
        // Granting needs a credential that exists; revoking never does, so a
        // stale grant to a deleted credential is always clearable.
        if (b.allowed && !vault.get(credId)) return json(res, 404, { error: 'unknown_credential' });
        agent.credentials = setCredentialAllowed(agent.credentials, credId, b.allowed, vault.ids());
        saveClients(clients);
        return json(res, 200, agentInfo(agent));
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    }

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

    const agentTokenM = /^\/api\/clients\/([^/]+)\/token$/.exec(pathname);
    if (agentTokenM && req.method === 'POST') {
      const agent = clients.find((c) => c.id === agentTokenM[1]);
      if (!agent) return json(res, 404, { error: 'not_found' });
      agent.token = randomBytes(24).toString('hex');
      saveClients(clients);
      return json(res, 200, agentInfo(agent));
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
      // Its pending requests go with it: approving one would grant access to an
      // agent whose token was just revoked.
      credentialRequests.forgetAgent(clientM[1]);
      cliInstallRequests.forgetAgent(clientM[1]);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/servers' && req.method === 'GET') return json(res, 200, withLastLog(withAccounts(supervisor.list())));

    // add a server (custom config, or a registry entry merged with overrides)
    if (pathname === '/api/servers' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req)) as ManagedServerConfig & { token?: unknown };
        const { token, ...cfg } = body;
        cfg.runtime = cfg.runtime === 'docker' ? 'docker' : cfg.runtime === 'remote' ? 'remote' : 'process';
        const isRemote = cfg.runtime === 'remote';
        // Remote needs a url; a process server needs a command; a docker server
        // needs an image (its entrypoint runs when no command is given).
        if (!cfg.id || !cfg.name || (isRemote ? !cfg.url : !cfg.command && !cfg.image))
          return json(res, 400, { error: isRemote ? 'id, name, and url required' : 'id, name, and a command or image required' });
        // `hypergate` is the gateway's own builtin namespace (hypergate__*): a
        // server with that id could shadow or be shadowed by the vault tools.
        if (cfg.id === BUILTIN_NS) return json(res, 400, { error: `"${BUILTIN_NS}" is a reserved id` });
        if (servers.some((s) => s.id === cfg.id)) return json(res, 409, { error: 'id_exists' });
        if (cfg.credentialRefs !== undefined) {
          if (typeof cfg.credentialRefs !== 'object' || Array.isArray(cfg.credentialRefs)) {
            return json(res, 400, { error: 'credentialRefs must map ENV_VAR to a credential id' });
          }
          for (const [envName, credId] of Object.entries(cfg.credentialRefs)) {
            if (!isValidEnvVar(envName)) return json(res, 400, { error: `credentialRefs key "${envName}" is not a valid env var name` });
            if (typeof credId !== 'string' || !vault.get(credId)) return json(res, 400, { error: `unknown credential "${String(credId)}"` });
          }
        }
        cfg.enabled = cfg.enabled ?? true;
        if (isRemote) {
          cfg.command = cfg.command ?? '';
          cfg.transport = cfg.transport === 'sse' ? 'sse' : 'http';
          cfg.auth = cfg.auth === 'none' || cfg.auth === 'token' ? cfg.auth : 'oauth';
          if (cfg.auth === 'token' && token !== undefined) {
            if (typeof token !== 'string' || !token.trim()) return json(res, 400, { error: 'token must be a non-empty string' });
            secretStore(cfg.id).save(TOKEN_KEY, token.trim());
          }
        }
        servers.push(cfg);
        saveConfig(servers);

        // Remote + OAuth: kick off the browser flow. If tokens already exist
        // (re-add), connect straight away; otherwise return the sign-in URL.
        if (isRemote && usesOAuth(cfg)) {
          const result = await runOAuth(cfg);
          if (result.authorized) {
            await supervisor.start(cfg);
            return json(res, 200, statusFor(cfg));
          }
          supervisor.markAuthorizing(cfg);
          return json(res, 200, { ...statusFor(cfg), authUrl: result.authUrl, error: result.error } as ServerStatus);
        }

        if (isRemote && cfg.auth === 'token' && !storedBearerToken(cfg)) {
          const error = `Paste a ${cfg.name} access token to connect.`;
          return json(res, 200, supervisor.markAuthorizing(cfg, error));
        }
        if (cfg.enabled) await supervisor.start(cfg);
        return json(res, 200, statusFor(cfg) ?? { id: cfg.id, state: 'stopped' });
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
      if (cfg.auth === 'token' && !packagerClientId(cfg))
        return json(res, 200, supervisor.markAuthorizing(cfg, `Paste a ${cfg.name} access token to connect.`));
      // A token entry that got here is on the client-id escape hatch, and stays
      // a token entry. The hatch is only what a packager set (config or env): an
      // app the *user* registered must never convert a connection they explicitly
      // chose to authenticate with a pasted token.
      if (cfg.auth !== 'token') cfg.auth = cfg.auth === 'none' ? 'none' : 'oauth';
      const result = await runOAuth(cfg);
      if (result.authorized) {
        cfg.enabled = true;
        saveConfig(servers);
        await supervisor.start(cfg);
        return json(res, 200, statusFor(cfg));
      }
      supervisor.markAuthorizing(cfg);
      return json(res, 200, { ...statusFor(cfg), authUrl: result.authUrl, error: result.error } as ServerStatus);
    }

    // ── the one-time OAuth app, for providers that don't register one for you ──
    // Read: is an app configured for this provider, where did it come from, and
    // what redirect URI does this daemon actually use (the provider's form wants
    // it character-for-character, and the port is not always 7777).
    //
    // The id names a *catalog* entry, not a managed server, because the setup
    // happens before the server is added: it is the thing that makes adding it
    // work. Only ids we ship an entry for are answerable, so this can't be used
    // to fish around the keychain.
    const oauthAppM = /^\/api\/oauth\/app\/([A-Za-z0-9._-]{1,64})$/.exec(pathname);
    if (oauthAppM) {
      const id = oauthAppM[1];
      const entry = REGISTRY.find((e) => e.id === id);
      if (!entry) return json(res, 404, { error: 'unknown_provider' });
      const cfg = servers.find((s) => s.id === id) ?? ({ id, name: entry.name } as ManagedServerConfig);
      const requirement = registryConnections(entry).find((connection) => connection.oauthApp)?.oauthApp ?? entry.oauthApp;

      if (req.method === 'GET') {
        const clientId = resolvedClientId(cfg);
        const info: OAuthAppInfo = {
          serverId: id,
          configured: !!clientId,
          source: clientIdSource(cfg),
          clientIdHint: clientId ? maskCredential(clientId) : undefined,
          hasSecret: !!resolvedClientSecret(cfg),
          redirectUri: OAUTH_REDIRECT,
          storage: useKeychain() ? 'keychain' : 'file',
          requirement,
        };
        return json(res, 200, info);
      }
      // Writing one is guarded exactly like /api/shutdown, and for the same
      // reason: management mutations are intentionally local, so the centralized
      // request guard above is the CSRF barrier. A bearer token alone is not a
      // browser CSRF defense because `/api/gateway` is readable by local callers.
      if (req.method === 'POST' || req.method === 'DELETE') {
        if (authScope(req)?.kind !== 'master') return json(res, 401, { error: 'unauthorized' });
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req)) as { clientId?: unknown; clientSecret?: unknown };
          const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
          const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
          if (!clientId) return json(res, 400, { error: 'clientId required' });
          if (requirement?.secretRequired && !clientSecret)
            return json(res, 400, { error: `${entry.name} requires a client secret as well as a client ID.` });
          const store = appStore(id);
          store.save(K_APP_CLIENT_ID, clientId);
          if (clientSecret) store.save(K_APP_CLIENT_SECRET, clientSecret);
          else store.remove(K_APP_CLIENT_SECRET);
          // A previous attempt can leave a dynamically-registered client and a
          // half-finished PKCE flow behind in the *grant*; both would outlive what
          // was just saved, so the next sign-in starts from the user's own app.
          // `'client'` is the SDK's own key for that registration (core/oauth.ts).
          secretStore(id).remove('client');
          makeProvider(cfg).clearFlowState();
          process.stderr.write(`[oauth] stored an OAuth app for ${id} (${useKeychain() ? 'keychain' : 'file'})\n`);
          return json(res, 200, { ok: true, configured: true });
        } catch {
          return json(res, 400, { error: 'invalid_json' });
        }
      }
      if (req.method === 'DELETE') {
        const store = appStore(id);
        store.remove(K_APP_CLIENT_ID);
        store.remove(K_APP_CLIENT_SECRET);
        // Clearing the app also drops any auto-registered client, so a later
        // sign-in cannot quietly fall back to a registration nobody remembers.
        secretStore(id).remove('client');
        return json(res, 200, { ok: true });
      }
    }

    // Set or replace a bearer credential without ever putting it in the server
    // config or response. A rejected token follows the same authorizing path as
    // OAuth so the UI can ask for a replacement instead of showing a crash.
    const tokenM = /^\/api\/servers\/([^/]+)\/token$/.exec(pathname);
    if (tokenM && req.method === 'POST') {
      const cfg = servers.find((s) => s.id === tokenM[1]);
      if (!cfg) return json(res, 404, { error: 'not_found' });
      if (cfg.runtime !== 'remote' || cfg.auth !== 'token') return json(res, 400, { error: 'not a token-auth remote server' });
      try {
        const body = JSON.parse(await readBody(req)) as { token?: unknown };
        if (typeof body.token !== 'string' || !body.token.trim()) return json(res, 400, { error: 'token must be a non-empty string' });
        secretStore(cfg.id).save(TOKEN_KEY, body.token.trim());
        cfg.enabled = true;
        saveConfig(servers);
        await supervisor.stop(cfg.id);
        await supervisor.start(cfg);
        return json(res, 200, statusFor(cfg));
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
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
      return json(res, 200, statusFor(cfg));
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

  server.listen(PORT, LISTEN_HOST, () => {
    if (process.env.HYPERGATE_NO_AUTH === '1') {
      process.stderr.write(
        '!!! WARNING: HYPERGATE_NO_AUTH=1 disables authentication; this is intended for local tests only. !!!\n',
      );
    }
    process.stdout.write(`hypergated up — UI + API on http://localhost:${PORT} · MCP gateway at /mcp\n`);
  });
}
