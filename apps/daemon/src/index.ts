import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join, extname, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Supervisor, createGateway, REGISTRY, searchRegistry, KNOWN_CLIS, HypergateOAuthProvider, type OAuthStore } from '@hypergate/core';
import { openStore } from './store.ts';
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
} from '@hypergate/shared';

/**
 * hypergated — the Hypergate daemon. Two modes:
 *   • default: one localhost port serving the management API, the web UI, and
 *     the streamable-HTTP MCP gateway at /mcp (bearer-token auth).
 *   • `--stdio`: connect the aggregating gateway to stdio so an agent harness
 *     (Claude Code, Cursor, Open Paw) can spawn `hypergated --stdio` as ONE
 *     MCP endpoint that fans out to all enabled servers.
 *
 * Local-first: binds to localhost. The daemon makes outbound calls only for
 * user-initiated actions — registry search, and connecting to the remote MCP
 * servers a user adds (plus their OAuth login/token exchange). OAuth tokens are
 * stored locally under ~/.hypergate/oauth/ and nothing phones home on its own.
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
const OAUTH_DIR = join(DATA_DIR, 'oauth');
const PORT = Number(process.env.PORT ?? 7777);
const VERSION = '0.8.0';
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

/** The gateway bearer token: generated once, persisted, never logged. */
const loadToken = (): string => {
  try {
    if (existsSync(TOKEN_PATH)) {
      const t = readFileSync(TOKEN_PATH, 'utf8').trim();
      if (t) return t;
    }
  } catch {
    /* regenerate below */
  }
  const t = randomBytes(24).toString('hex');
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, t);
  return t;
};

// ── desktop / service settings (autostart + tray behavior) ─────────────────
// Preferences live in ~/.hypergate/settings.json. `runOnStartup` is backed by
// an OS autostart entry so it reflects reality even when changed outside the
// app; `startMinimized` is read by the tray launcher (scripts/hypergate-tray.ps1)
// to decide whether to open the manager UI on launch. Windows-only for now
// (matches the tray); a no-op that reports `startupSupported: false` elsewhere.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TRAY_PS1 = join(REPO_ROOT, 'scripts', 'hypergate-tray.ps1');
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Hypergate';
const STARTUP_SUPPORTED = process.platform === 'win32';
const pexecFile = promisify(execFile);

/** Run a PowerShell script via -EncodedCommand (base64/UTF-16LE) to sidestep all shell quoting. */
const runPowerShell = async (script: string): Promise<string> => {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await pexecFile('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ]);
  return stdout.trim();
};

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

const defaultSettings = (): DaemonSettings => ({ runOnStartup: false, startMinimized: true });
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

/** Is the Windows autostart entry present? (Always false on unsupported platforms.) */
const isStartupEnabled = async (): Promise<boolean> => {
  if (!STARTUP_SUPPORTED) return false;
  try {
    const out = await runPowerShell(
      `$p = Get-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction SilentlyContinue; if ($p) { 'yes' } else { 'no' }`,
    );
    return out.endsWith('yes');
  } catch {
    return false;
  }
};
/** Add/remove the autostart entry that launches the tray hidden at login. */
const setStartupEnabled = async (on: boolean): Promise<void> => {
  if (!STARTUP_SUPPORTED) return;
  if (on) {
    const launch = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${TRAY_PS1}"`;
    await runPowerShell(
      `New-Item -Path '${RUN_KEY}' -Force | Out-Null; Set-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_VALUE}' -Value '${launch.replace(/'/g, "''")}'`,
    );
  } else {
    await runPowerShell(`Remove-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction SilentlyContinue`);
  }
};

/** The `/api/settings` payload: persisted prefs reconciled with the real OS autostart state. */
const settingsInfo = async (): Promise<SettingsInfo> => {
  const s = loadSettings();
  return {
    runOnStartup: await isStartupEnabled(),
    startMinimized: s.startMinimized,
    platform: process.platform,
    startupSupported: STARTUP_SUPPORTED,
  };
};

// ── OAuth for remote servers ───────────────────────────────────────────────
// Each remote server's OAuth state (registered client, tokens, PKCE verifier,
// CSRF state) lives in one JSON file under ~/.hypergate/oauth/. The provider is
// store-backed (see @hypergate/core) so the daemon owns all the filesystem IO.
const oauthFile = (id: string): string => join(OAUTH_DIR, `${encodeURIComponent(id)}.json`);
const readOAuth = (id: string): Record<string, string> => {
  try {
    if (existsSync(oauthFile(id))) return JSON.parse(readFileSync(oauthFile(id), 'utf8')) as Record<string, string>;
  } catch {
    /* corrupt file → start fresh */
  }
  return {};
};
const fileStore = (id: string): OAuthStore => ({
  load: (key) => readOAuth(id)[key],
  save: (key, value) => {
    mkdirSync(OAUTH_DIR, { recursive: true });
    writeFileSync(oauthFile(id), JSON.stringify({ ...readOAuth(id), [key]: value }, null, 2));
  },
  remove: (key) => {
    const o = readOAuth(id);
    delete o[key];
    if (existsSync(oauthFile(id))) writeFileSync(oauthFile(id), JSON.stringify(o, null, 2));
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
  new HypergateOAuthProvider(fileStore(cfg.id), {
    redirectUrl: OAUTH_REDIRECT,
    clientName: 'Hypergate',
    clientId: resolvedClientId(cfg),
    clientSecret: resolvedClientSecret(cfg),
    scope: cfg.scope,
  });
/** A remote server that uses OAuth and has no usable token yet needs the user to sign in. */
const needsAuth = (cfg: ManagedServerConfig): boolean =>
  cfg.runtime === 'remote' && cfg.auth !== 'none' && !makeProvider(cfg).hasTokens();

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
});
let servers = loadConfig();

const startEnabled = async (): Promise<void> => {
  for (const s of servers) {
    if (!s.enabled) continue;
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
  servers.find((s) => s.runtime === 'remote' && fileStore(s.id).load('state') === state);

// ── stdio gateway mode (the single aggregated endpoint for harnesses) ──────
if (STDIO_MODE) {
  await startEnabled();
  const gateway = createGateway(supervisor, { name: 'hypergate-gateway', version: VERSION }, { caller: 'stdio (local)' });
  await gateway.connect(new StdioServerTransport());
  // stdout is the MCP channel now; logs must go to stderr only.
  process.stderr.write(`hypergated gateway (stdio) up — ${supervisor.ids().length} server(s)\n`);
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

  await startEnabled();
  const TOKEN = process.env.HYPERGATE_TOKEN ?? loadToken();
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  // A minimal self-contained result page shown in the OAuth popup after sign-in.
  const oauthPage = (res: ServerResponse, ok: boolean, message: string): void => {
    const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Hypergate · ${ok ? 'Connected' : 'Sign-in failed'}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#0f1117;color:#e7e9ee}
.card{max-width:420px;padding:32px 34px;border-radius:16px;background:#171a23;border:1px solid #262b38;text-align:center}
.mark{font-size:38px}.h{font-size:19px;font-weight:600;margin:14px 0 6px;background:linear-gradient(90deg,#8b5cf6,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
.m{color:#aab0be}.ok{color:#34d399}.err{color:#f87171}</style></head>
<body><div class="card"><div class="mark">${ok ? '🐾' : '⚠️'}</div>
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
      connectCommand: `claude mcp add -t http hypergate-${a.id} ${url} -H "Authorization: Bearer ${a.token}"`,
      clientSnippet: {
        mcpServers: { [`hypergate-${a.id}`]: { type: 'http', url, headers: { Authorization: `Bearer ${a.token}` } } },
      },
    };
  };

  const slugId = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
  /** Normalize a servers allow-list from a request body to `'*' | string[]`. */
  const normServers = (v: unknown): '*' | string[] =>
    v === '*' ? '*' : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  // Built web UI (apps/web/dist) — same relative path from src/ and dist/.
  const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
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

    // ── desktop/service settings (autostart + start-minimized) ───────────────
    if (pathname === '/api/settings' && req.method === 'GET') return json(res, 200, await settingsInfo());
    if (pathname === '/api/settings' && req.method === 'PATCH') {
      try {
        const b = JSON.parse(await readBody(req)) as UpdateSettingsRequest;
        const cur = loadSettings();
        if (typeof b.startMinimized === 'boolean') cur.startMinimized = b.startMinimized;
        if (typeof b.runOnStartup === 'boolean' && STARTUP_SUPPORTED) {
          await setStartupEnabled(b.runOnStartup);
          cur.runOnStartup = b.runOnStartup;
        }
        saveSettings(cur);
        return json(res, 200, await settingsInfo());
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : 'invalid_json' });
      }
    }

    // ── connected agents (scoped gateway tokens) ─────────────────────────────
    if (pathname === '/api/clients' && req.method === 'GET') return json(res, 200, clients.map(agentInfo));
    if (pathname === '/api/clients' && req.method === 'POST') {
      try {
        const b = JSON.parse(await readBody(req)) as { name?: string; servers?: unknown };
        const name = (b.name ?? '').trim();
        if (!name) return json(res, 400, { error: 'name required' });
        const agent: AgentClient = {
          id: `${slugId(name)}-${randomBytes(2).toString('hex')}`,
          name,
          token: randomBytes(24).toString('hex'),
          servers: normServers(b.servers),
          createdAt: new Date().toISOString(),
        };
        clients.push(agent);
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
        if (typeof b.name === 'string' && b.name.trim()) agent.name = b.name.trim();
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

    if (pathname === '/api/servers' && req.method === 'GET') return json(res, 200, supervisor.list());

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

    const rmM = /^\/api\/servers\/([^/]+)$/.exec(pathname);
    if (rmM && req.method === 'DELETE') {
      const id = rmM[1];
      await supervisor.remove(id);
      servers = servers.filter((s) => s.id !== id);
      saveConfig(servers);
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

    // disconnect: sign out (drop stored OAuth tokens) and stop the server.
    const discM = /^\/api\/servers\/([^/]+)\/disconnect$/.exec(pathname);
    if (discM && req.method === 'POST') {
      const cfg = servers.find((s) => s.id === discM[1]);
      if (!cfg) return json(res, 404, { error: 'not_found' });
      await supervisor.stop(cfg.id);
      makeProvider(cfg).invalidateCredentials('all');
      cfg.enabled = false;
      saveConfig(servers);
      supervisor.markAuthorizing(cfg);
      return json(res, 200, supervisor.status(cfg.id));
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
  server.listen(PORT, '127.0.0.1', () => process.stdout.write(`hypergated up — UI + API on http://localhost:${PORT} · MCP gateway at /mcp\n`));
}
