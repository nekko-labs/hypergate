import { posix, win32 } from 'node:path';
import type { AmbientFinding, AmbientRemoval, AmbientStorage } from '@hypergate/shared';
import { CREDENTIAL_GUIDES } from './credential-catalog.js';
import { maskSecret } from './credentials.js';

/**
 * Ambient credentials: logins a tool keeps for itself, outside the vault.
 *
 * Credential lockdown only means something if the keys an agent could reach
 * *without* Hypergate are gone. This module is the curated half of finding
 * them: where each tool keeps its login, how to read it, and how to take it out
 * again. Same trust rule as the CLI and credential catalogs: a location is
 * listed only when it was checked against the vendor's own docs or source
 * (`verifiedFrom` on each rule), and every rule writes down what a hit does
 * **not** prove (`caveat`). No guessed paths, because a sweep that reports
 * "nothing found" on the strength of a wrong path is worse than no sweep.
 *
 * Pure: every read goes through the injected `AmbientContext`, so tests run on
 * fixtures and the daemon decides when and how often to touch the disk. The
 * value is read only so that the import path can move it; `toFinding` strips it,
 * and nothing that reaches the API, a log, an alert, or the UI carries one.
 */

/** Everything a scan needs from the machine, injected. */
export interface AmbientContext {
  home: string;
  platform: string;
  env: Record<string, string | undefined>;
  /** File contents, or undefined when absent or unreadable. */
  readFile(path: string): string | undefined;
}

/** A command run without a shell: file plus args. */
export interface AmbientCommand {
  file: string;
  args: string[];
}

/** How to take the value out of a file's text. */
export type AmbientEdit =
  /** Replace one line with a Hypergate marker comment using this comment prefix. */
  | { kind: 'comment-line'; line: number; prefix: string }
  /** Drop one line outright (formats that allow no comments, e.g. git-credentials). */
  | { kind: 'drop-line'; line: number }
  /** JSON document: delete the key, or set it to null. */
  | { kind: 'json-key'; key: string; to: 'delete' | 'null' }
  /** Replace one line with this exact text (e.g. an env reference in place of the literal). */
  | { kind: 'replace-line'; line: number; text: string };

/** A finding plus what only the daemon's import path may see. */
export interface AmbientHit extends AmbientFinding {
  /** The literal value, when it sits in plain text. Import path only. */
  value?: string;
  /** The vendor command that prints the value, when it sits in a keyring. */
  valueCommand?: AmbientCommand;
  /** The vendor logout command (`vendor-logout` removals). */
  logout?: AmbientCommand;
  /** The file edit (`edit` removals). */
  edit?: AmbientEdit;
}

/** One curated location. */
export interface AmbientRule {
  id: string;
  tool: string;
  /** Vendor doc or source the location and format were checked against. */
  verifiedFrom: string;
  /** What a hit from this rule does not prove. */
  caveat: string;
  scan(ctx: AmbientContext): AmbientHit[];
}

// ── helpers ────────────────────────────────────────────────────────────────

const pathFor = (platform: string) => (platform === 'win32' ? win32 : posix);

/** FNV-1a, 32-bit, hex. Stable ids without a crypto dependency or a value in them. */
const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** A stable, value-free id for a finding: rule + place + key. */
export const ambientId = (rule: string, location: string, key: string): string =>
  `${rule}-${fnv(`${location}\u0000${key}`)}`;

/**
 * A short, non-reversible fingerprint of a value, so the watcher can tell "the
 * same login" from "a new login in the same place" without storing the value.
 * 32 bits of FNV over a high-entropy token reveals nothing usable.
 */
export const ambientFingerprint = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : fnv(`hypergate-ambient\u0000${value}`);

const unquote = (raw: string): string => {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))))
    return v.slice(1, -1);
  return v;
};

/**
 * Whether a configured value is a literal secret rather than a reference to one.
 * `export OPENAI_API_KEY=$(op read ...)` or `${NPM_TOKEN}` keeps no key in the
 * file, so it is not ambient, and flagging it would teach people to ignore the
 * sweep.
 */
export const isLiteralSecret = (raw: string | undefined | null): raw is string => {
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (v.length < 8) return false;
  if (/[$`]/.test(v)) return false;
  if (/^(op|vault|keychain|secret|env):\/\//i.test(v)) return false;
  if (/^<.*>$/.test(v)) return false;
  if (/^(x+|\.+|\*+|your[-_].*|changeme|placeholder|replace[-_]?me|todo|null|none|undefined|true|false)$/i.test(v))
    return false;
  return true;
};

/** Env var name → guide service, from the credential catalog (canonical and aliases). */
const SERVICE_BY_ENV: ReadonlyMap<string, { service: string; envVar: string }> = (() => {
  const m = new Map<string, { service: string; envVar: string }>();
  for (const g of CREDENTIAL_GUIDES) {
    m.set(g.envVar, { service: g.service, envVar: g.envVar });
    for (const a of g.aliases ?? []) if (!m.has(a)) m.set(a, { service: g.service, envVar: g.envVar });
  }
  return m;
})();

/** Names that are almost certainly a secret even without a guide. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]*_(API_KEY|APIKEY|TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET|SECRET_KEY|ACCESS_KEY|PAT)$/;

/** Whether an env var name is one the sweep cares about, and what it maps to. */
export const classifyEnvVar = (name: string): { service?: string; envVar: string } | undefined => {
  const known = SERVICE_BY_ENV.get(name);
  if (known) return known;
  if (SECRET_NAME.test(name)) return { envVar: name };
  return undefined;
};

const guideName = (service: string | undefined): string | undefined =>
  service ? CREDENTIAL_GUIDES.find((g) => g.service === service)?.name : undefined;

interface HitInit {
  rule: AmbientRule;
  location: string;
  key: string;
  detail?: string;
  storage: AmbientStorage;
  value?: string;
  service?: string;
  envVar?: string;
  removal: AmbientRemoval;
  importable?: boolean;
  edit?: AmbientEdit;
  logout?: AmbientCommand;
  valueCommand?: AmbientCommand;
  manualStep?: string;
  tool?: string;
  caveat?: string;
}

const hit = (i: HitInit): AmbientHit => {
  const envVar = i.envVar ?? (i.service ? CREDENTIAL_GUIDES.find((g) => g.service === i.service)?.envVar : undefined);
  const importable =
    i.importable ?? ((i.value !== undefined || i.valueCommand !== undefined) && (Boolean(i.service) || Boolean(envVar)));
  return {
    id: ambientId(i.rule.id, i.location, i.key),
    rule: i.rule.id,
    tool: i.tool ?? i.rule.tool,
    service: i.service,
    envVar,
    location: i.location,
    detail: i.detail,
    storage: i.storage,
    hint: i.value !== undefined ? maskSecret(i.value) : undefined,
    importable,
    removal: i.removal,
    removeCommand: i.logout ? [i.logout.file, ...i.logout.args].join(' ') : undefined,
    manualStep: i.manualStep,
    caveat: i.caveat ?? i.rule.caveat,
    value: i.value,
    valueCommand: i.valueCommand,
    logout: i.logout,
    edit: i.edit,
  };
};

/** Strip everything the API must never carry. */
export const toFinding = (h: AmbientHit): AmbientFinding => {
  const { value: _v, valueCommand: _vc, logout: _l, edit: _e, ...finding } = h;
  return finding;
};

const lines = (text: string): string[] => text.split(/\r?\n/);

/** Minimal INI: section → key → { value, line }. Enough for AWS credentials and the like. */
const parseIni = (text: string): Map<string, Map<string, { value: string; line: number }>> => {
  const out = new Map<string, Map<string, { value: string; line: number }>>();
  let section = '';
  lines(text).forEach((raw, line) => {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) return;
    const sec = /^\[(.+)\]$/.exec(l);
    if (sec) {
      section = sec[1].trim();
      return;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(l);
    if (!kv) return;
    if (!out.has(section)) out.set(section, new Map());
    out.get(section)!.set(kv[1].trim().toLowerCase(), { value: kv[2].trim(), line });
  });
  return out;
};

/**
 * A dotenv / shell assignment on one line. Covers what people actually write:
 * `export X=v`, `X=v`, `set -gx X v` (fish), `$env:X = "v"` (PowerShell),
 * `setx X v` is deliberately not matched (it is a command, not a stored value).
 */
const ASSIGNMENT: RegExp[] = [
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
  /^\s*set\s+(?:-[a-zA-Z]+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s+(.*?)\s*$/,
  /^\s*\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*;?\s*$/i,
];

/** Drop a trailing ` # comment` from an unquoted shell value. */
const stripInlineComment = (v: string): string => {
  const t = v.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    const end = t.indexOf(q, 1);
    return end > 0 ? t.slice(0, end + 1) : t;
  }
  return t.replace(/\s+#.*$/, '');
};

interface Assignment {
  name: string;
  value: string;
  line: number;
  /**
   * The line is exactly one assignment: a quoted value, or a single unquoted
   * token, then at most a trailing `# comment`. Anything else on the line (a
   * `;`, `&&`, `||`, `|`, a backtick, or a command after the value) makes it
   * compound, and a compound line is reported but never edited, because
   * commenting it out would also remove whatever else the line runs.
   */
  simple: boolean;
}

/** Shell control characters that put a second statement on the line. */
const SHELL_CONTROL = /[;&|`]/;

/** Whether the right-hand side of an assignment is one value and nothing more. */
export const isSimpleAssignmentValue = (rhs: string, powershell = false): boolean => {
  let t = rhs.trim();
  if (powershell) t = t.replace(/;\s*$/, '').trim();
  let rest: string;
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = t.indexOf(t[0], 1);
    if (end < 0) return false;
    rest = t.slice(end + 1);
  } else {
    const m = /^(\S*)(.*)$/.exec(t)!;
    if (SHELL_CONTROL.test(m[1])) return false;
    rest = m[2];
  }
  rest = rest.trim();
  return rest === '' || /^#/.test(rest);
};

const parseAssignments = (text: string): Assignment[] => {
  const out: Assignment[] = [];
  lines(text).forEach((raw, line) => {
    if (/^\s*#/.test(raw)) return;
    for (const [i, re] of ASSIGNMENT.entries()) {
      const m = re.exec(raw);
      if (!m) continue;
      const simple = isSimpleAssignmentValue(m[2], i === 2);
      const v = stripInlineComment(m[2]);
      // A compound line's value is cut at the first control character so the
      // hint and the secret check see the key, not the command after it.
      const value = unquote(simple ? v : v.split(SHELL_CONTROL)[0].trim().split(/\s+/)[0] ?? '');
      out.push({ name: m[1], value, line, simple });
      return;
    }
  });
  return out;
};

const readJson = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** XDG config home, honouring the env var. */
const xdgConfig = (ctx: AmbientContext): string =>
  ctx.env.XDG_CONFIG_HOME || pathFor(ctx.platform).join(ctx.home, '.config');

const appData = (ctx: AmbientContext): string =>
  ctx.env.APPDATA || pathFor(ctx.platform).join(ctx.home, 'AppData', 'Roaming');

// ── rules ──────────────────────────────────────────────────────────────────

/** GitHub CLI: hosts.yml, with the token either in the file or in the OS keyring. */
const ghHosts: AmbientRule = {
  id: 'gh-hosts',
  tool: 'GitHub CLI',
  verifiedFrom:
    'https://cli.github.com/manual/gh_auth_login (credential store by default, plain text fallback); cli/cli internal/config/config.go (keyring service "gh:" + host, `oauth_token` key under hosts.<host>); https://cli.github.com/manual/gh_auth_logout (removes locally, does not revoke)',
  caveat:
    'A host entry without `oauth_token` means the token is in the OS keyring; Hypergate reads it with `gh auth token` only when you import. A listed host does not prove the token is still valid on GitHub.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const dir =
      ctx.env.GH_CONFIG_DIR ||
      (ctx.env.XDG_CONFIG_HOME
        ? p.join(ctx.env.XDG_CONFIG_HOME, 'gh')
        : ctx.platform === 'win32'
          ? p.join(appData(ctx), 'GitHub CLI')
          : p.join(ctx.home, '.config', 'gh'));
    const file = p.join(dir, 'hosts.yml');
    const text = ctx.readFile(file);
    if (text === undefined) return [];
    // hosts.yml is flat enough to read by indentation: a host is a top-level
    // key, `user:` and `oauth_token:` sit one level under it (or under
    // `users.<login>` for the multi-account layout).
    const out: AmbientHit[] = [];
    let host: string | undefined;
    let user: string | undefined;
    let token: string | undefined;
    let childIndent: number | undefined;
    let multi = false;
    const flush = (): void => {
      if (!host) return;
      // With a `users:` block the file holds several accounts' tokens. Only
      // `gh auth token` is sure to answer for the active one, which is the one
      // the logout below removes, so the value always comes from gh then.
      const inFile = token !== undefined;
      if (multi) token = undefined;
      const service = host === 'github.com' ? 'github' : undefined;
      const logout: AmbientCommand = {
        file: 'gh',
        args: ['auth', 'logout', '--hostname', host, ...(user ? ['--user', user] : [])],
      };
      out.push(
        hit({
          rule: ghHosts,
          location: file,
          key: host,
          detail: user ? `${host} (${user})` : host,
          storage: inFile ? 'plaintext' : 'keyring',
          value: token,
          valueCommand: token ? undefined : { file: 'gh', args: ['auth', 'token', '--hostname', host] },
          service,
          envVar: service ? undefined : 'GH_ENTERPRISE_TOKEN',
          removal: 'vendor-logout',
          logout,
        }),
      );
    };
    for (const raw of lines(text)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const top = /^([^\s#][^:]*):\s*$/.exec(raw);
      if (top) {
        flush();
        host = top[1].trim();
        user = undefined;
        token = undefined;
        childIndent = undefined;
        multi = false;
        continue;
      }
      if (!host) continue;
      const indent = /^\s*/.exec(raw)![0].length;
      childIndent ??= indent;
      // Only the host's own keys count; `users.<login>.*` sit deeper.
      if (indent !== childIndent) continue;
      if (/^\s+users:\s*$/.test(raw)) multi = true;
      const u = /^\s+user:\s*(\S+)\s*$/.exec(raw);
      if (u) user = unquote(u[1]);
      const t = /^\s+oauth_token:\s*(\S+)\s*$/.exec(raw);
      if (t && !token && isLiteralSecret(unquote(t[1]))) token = unquote(t[1]);
    }
    flush();
    return out;
  },
};

/** Fly.io: `access_token` in ~/.fly/config.yml (or $FLY_CONFIG_DIR). */
const flyConfig: AmbientRule = {
  id: 'fly-config',
  tool: 'Fly.io CLI',
  verifiedFrom:
    'superfly/flyctl helpers/config.go (FLY_CONFIG_DIR, else ~/.fly); internal/config/config.go (FileName "config.yml", key "access_token")',
  caveat: 'A token in the file does not prove it is still valid at Fly.io, or which organizations it can reach.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const file = p.join(ctx.env.FLY_CONFIG_DIR || p.join(ctx.home, '.fly'), 'config.yml');
    const text = ctx.readFile(file);
    if (text === undefined) return [];
    const out: AmbientHit[] = [];
    lines(text).forEach((raw, line) => {
      const m = /^access_token:\s*(.+?)\s*$/.exec(raw);
      if (!m) return;
      const value = unquote(m[1]);
      if (!isLiteralSecret(value)) return;
      out.push(
        hit({
          rule: flyConfig,
          location: file,
          key: 'access_token',
          storage: 'plaintext',
          value,
          service: 'fly',
          removal: 'edit',
          edit: { kind: 'comment-line', line, prefix: '#' },
        }),
      );
    });
    return out;
  },
};

/** AWS shared credentials file: detect only (an access key is two values). */
const awsCredentials: AmbientRule = {
  id: 'aws-credentials',
  tool: 'AWS CLI',
  verifiedFrom:
    'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html (~/.aws/credentials, AWS_SHARED_CREDENTIALS_FILE, aws_secret_access_key)',
  caveat:
    'An AWS key is an id and a secret together, which the vault does not model as one value yet, so this is reported but not imported. It does not prove the key is active, or what its IAM policy allows.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const file = ctx.env.AWS_SHARED_CREDENTIALS_FILE || p.join(ctx.home, '.aws', 'credentials');
    const text = ctx.readFile(file);
    if (text === undefined) return [];
    const out: AmbientHit[] = [];
    for (const [profile, keys] of parseIni(text)) {
      const secret = keys.get('aws_secret_access_key');
      if (!secret || !isLiteralSecret(secret.value)) continue;
      out.push(
        hit({
          rule: awsCredentials,
          location: file,
          key: profile,
          detail: `profile ${profile || 'default'}`,
          storage: 'plaintext',
          value: secret.value,
          importable: false,
          removal: 'manual',
          manualStep:
            'Move this profile to AWS IAM Identity Center (`aws configure sso`) or a credential_process, then delete the keys from the file.',
        }),
      );
    }
    return out;
  },
};

/** Google Cloud application default credentials. Detect only. */
const gcloudAdc: AmbientRule = {
  id: 'gcloud-adc',
  tool: 'Google Cloud CLI',
  verifiedFrom:
    'https://docs.cloud.google.com/docs/authentication/application-default-credentials ($HOME/.config/gcloud/application_default_credentials.json, %APPDATA%\\gcloud\\...); https://docs.cloud.google.com/sdk/docs/configurations (CLOUDSDK_CONFIG)',
  caveat:
    'Application default credentials are an OAuth refresh token or a service account key file, not a single API key, so they are reported but not imported. `gcloud auth login` keeps a separate credential store this rule does not read.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const dir =
      ctx.env.CLOUDSDK_CONFIG ||
      (ctx.platform === 'win32' ? p.join(appData(ctx), 'gcloud') : p.join(ctx.home, '.config', 'gcloud'));
    const file = p.join(dir, 'application_default_credentials.json');
    const doc = readJson(ctx.readFile(file));
    if (!doc) return [];
    const kind = typeof doc.type === 'string' ? doc.type : 'credentials';
    return [
      hit({
        rule: gcloudAdc,
        location: file,
        key: 'adc',
        detail: kind,
        storage: 'plaintext',
        importable: false,
        removal: 'manual',
        manualStep: 'Run `gcloud auth application-default revoke` when nothing on this machine needs ADC.',
      }),
    ];
  },
};

/** Azure CLI MSAL token cache. Detect only. */
const azureMsal: AmbientRule = {
  id: 'azure-msal',
  tool: 'Azure CLI',
  verifiedFrom:
    'https://learn.microsoft.com/en-us/cli/azure/msal-based-azure-cli (MSAL cache, encrypted on Windows, plaintext on Linux and macOS); Azure/azure-cli azure-cli-core auth/identity.py (config_dir/"msal_token_cache")',
  caveat:
    'A token cache holds refresh tokens for whatever accounts signed in; it is not an API key and is not imported. On Windows the cache is encrypted to your user, which this rule still reports because any process running as you can use it.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const dir = ctx.env.AZURE_CONFIG_DIR || p.join(ctx.home, '.azure');
    for (const name of ['msal_token_cache.json', 'msal_token_cache.bin']) {
      const file = p.join(dir, name);
      const text = ctx.readFile(file);
      if (text === undefined || text.trim().length < 3 || /^\{\s*\}$/.test(text.trim())) continue;
      return [
        hit({
          rule: azureMsal,
          location: file,
          key: 'msal',
          storage: name.endsWith('.bin') ? 'keyring' : 'plaintext',
          importable: false,
          removal: 'manual',
          manualStep: 'Run `az logout` when nothing on this machine needs the Azure CLI signed in.',
        }),
      ];
    }
    return [];
  },
};

/** Vercel CLI: `token` in auth.json under the XDG data dir for com.vercel.cli. */
const vercelAuth: AmbientRule = {
  id: 'vercel-auth',
  tool: 'Vercel CLI',
  verifiedFrom:
    '@vercel/cli-config 0.4.0 dist/paths.js (xdg-app-paths data dir for "com.vercel.cli", legacy ~/.now and %APPDATA%\\xdg.data\\com.vercel.cli; auth.json) and dist/cred-storage.js (`token` key; keyring storage also supported)',
  caveat:
    'Newer Vercel CLIs can keep the token in the OS keyring instead, which this rule cannot see. `vercel logout` revokes the token at Vercel, so Hypergate removes it from the file instead of running it.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const dirs: string[] = [];
    if (ctx.platform === 'darwin') dirs.push(p.join(ctx.home, 'Library', 'Application Support', 'com.vercel.cli'));
    else if (ctx.platform === 'win32') {
      dirs.push(p.join(appData(ctx), 'com.vercel.cli', 'Data'));
      dirs.push(p.join(appData(ctx), 'xdg.data', 'com.vercel.cli'));
    } else dirs.push(p.join(ctx.env.XDG_DATA_HOME || p.join(ctx.home, '.local', 'share'), 'com.vercel.cli'));
    dirs.push(p.join(ctx.home, '.now'));
    for (const dir of dirs) {
      const file = p.join(dir, 'auth.json');
      const doc = readJson(ctx.readFile(file));
      const token = doc?.token;
      if (typeof token !== 'string' || !isLiteralSecret(token)) continue;
      return [
        hit({
          rule: vercelAuth,
          location: file,
          key: 'token',
          storage: 'plaintext',
          value: token,
          service: 'vercel',
          removal: 'edit',
          edit: { kind: 'json-key', key: 'token', to: 'delete' },
        }),
      ];
    }
    return [];
  },
};

/** Supabase CLI plain-text fallback: <SUPABASE_HOME or ~/.supabase>/access-token. */
const supabaseToken: AmbientRule = {
  id: 'supabase-token',
  tool: 'Supabase CLI',
  verifiedFrom:
    'https://supabase.com/docs/reference/cli/supabase-login (OS keyring first; fallback plain text file at <SUPABASE_HOME or ~/.supabase>/access-token)',
  caveat:
    'When the OS keyring is available the Supabase CLI stores its token there, which this rule cannot see; only the plain-text fallback is found.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const file = p.join(ctx.env.SUPABASE_HOME || p.join(ctx.home, '.supabase'), 'access-token');
    const value = ctx.readFile(file)?.trim();
    if (!isLiteralSecret(value)) return [];
    return [
      hit({
        rule: supabaseToken,
        location: file,
        key: 'access-token',
        storage: 'plaintext',
        value,
        service: 'supabase',
        removal: 'delete-file',
      }),
    ];
  },
};

/** npm: `//registry/:_authToken=` lines in the user config. */
const npmrc: AmbientRule = {
  id: 'npmrc',
  tool: 'npm',
  verifiedFrom:
    'https://docs.npmjs.com/cli/v10/configuring-npm/npmrc ($HOME/.npmrc or the userconfig param; `//registry.npmjs.org/:_authToken=` scoped key)',
  caveat:
    '`${NPM_TOKEN}` style references hold no token and are skipped. `npm logout` revokes the token at the registry, so Hypergate rewrites the line to `${NPM_TOKEN}` instead of running it; npm then reads the token `hypergate run` injects.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const file = ctx.env.NPM_CONFIG_USERCONFIG || ctx.env.npm_config_userconfig || p.join(ctx.home, '.npmrc');
    const text = ctx.readFile(file);
    if (text === undefined) return [];
    const out: AmbientHit[] = [];
    lines(text).forEach((raw, line) => {
      const m = /^\s*(\/\/[^\s=]+?):_authToken\s*=\s*(.+?)\s*$/.exec(raw);
      if (!m) return;
      const value = unquote(m[2]);
      if (!isLiteralSecret(value)) return;
      const registry = m[1].replace(/^\/\//, '').replace(/\/$/, '');
      const service = registry === 'registry.npmjs.org' ? 'npm' : undefined;
      out.push(
        hit({
          rule: npmrc,
          location: file,
          key: registry,
          detail: registry,
          storage: 'plaintext',
          value,
          service,
          importable: Boolean(service),
          removal: 'edit',
          // npm expands \${VAR} in .npmrc, so the line keeps working for
          // `hypergate run -- npm ...`, which injects NPM_TOKEN. Commenting it
          // out would leave npm with no way to find the injected token.
          edit: { kind: 'replace-line', line, text: `${m[1]}:_authToken=\${NPM_TOKEN}` },
        }),
      );
    });
    return out;
  },
};

/** Docker: base64 `auths.<registry>.auth` in config.json when no credential store is set. Detect only. */
const dockerConfig: AmbientRule = {
  id: 'docker-config',
  tool: 'Docker',
  verifiedFrom:
    'https://docs.docker.com/reference/cli/docker/login/ (without a credential store, credentials are saved base64-encoded in $HOME/.docker/config.json; credsStore/credHelpers move them out)',
  caveat:
    'An `auths` entry is a base64 username and password (or token) pair, so it is reported, not imported. With `credsStore` set, Docker keeps nothing in the file and there is nothing to find.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const file = p.join(ctx.env.DOCKER_CONFIG || p.join(ctx.home, '.docker'), 'config.json');
    const doc = readJson(ctx.readFile(file));
    const auths = doc?.auths;
    if (!auths || typeof auths !== 'object') return [];
    const out: AmbientHit[] = [];
    for (const [registry, entry] of Object.entries(auths as Record<string, unknown>)) {
      const auth = (entry as { auth?: unknown } | null)?.auth;
      if (typeof auth !== 'string' || !isLiteralSecret(auth)) continue;
      out.push(
        hit({
          rule: dockerConfig,
          location: file,
          key: registry,
          detail: registry,
          storage: 'plaintext',
          importable: false,
          removal: 'manual',
          manualStep: `Configure a Docker credential helper (credsStore), then run \`docker logout ${registry}\`.`,
        }),
      );
    }
    return out;
  },
};

/** ~/.netrc (_netrc on Windows): `machine ... password ...`. Detect only. */
const netrc: AmbientRule = {
  id: 'netrc',
  tool: 'netrc',
  verifiedFrom: 'GNU inetutils ftp(1) and curl --netrc documentation (~/.netrc; _netrc on Windows; machine/login/password tokens)',
  caveat: 'A netrc password can be anything from an API token to a real account password; it is reported, not imported.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const file = ctx.env.NETRC || p.join(ctx.home, ctx.platform === 'win32' ? '_netrc' : '.netrc');
    const text = ctx.readFile(file);
    if (text === undefined) return [];
    const tokens = text.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean);
    const out: AmbientHit[] = [];
    let machine: string | undefined;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === 'machine') machine = tokens[i + 1];
      else if (tokens[i] === 'default') machine = 'default';
      else if (tokens[i] === 'password' && machine && isLiteralSecret(tokens[i + 1])) {
        out.push(
          hit({
            rule: netrc,
            location: file,
            key: machine,
            detail: machine,
            storage: 'plaintext',
            importable: false,
            removal: 'manual',
            manualStep: `Remove the \`machine ${machine}\` entry once the tool that reads it uses a vault credential.`,
          }),
        );
        machine = undefined;
      }
    }
    return out;
  },
};

/** git-credential-store: one `https://user:secret@host` URL per line. */
const gitCredentials: AmbientRule = {
  id: 'git-credentials',
  tool: 'Git credential store',
  verifiedFrom:
    'https://git-scm.com/docs/git-credential-store (~/.git-credentials, then $XDG_CONFIG_HOME/git/credentials; one URL per line; no comment lines allowed)',
  caveat:
    'The password in a stored URL is only a token if you saved a token there. Only github.com entries are imported (as the GitHub token); the file allows no comments, so the line is dropped after a backup.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const files = [p.join(ctx.home, '.git-credentials'), p.join(xdgConfig(ctx), 'git', 'credentials')];
    const out: AmbientHit[] = [];
    for (const file of files) {
      const text = ctx.readFile(file);
      if (text === undefined) continue;
      lines(text).forEach((raw, line) => {
        const m = /^\s*([a-z][a-z0-9+.-]*):\/\/([^:@/\s]*):([^@/\s]+)@([^/\s]+)/i.exec(raw);
        if (!m) return;
        let secret: string;
        try {
          secret = decodeURIComponent(m[3]);
        } catch {
          secret = m[3];
        }
        if (!isLiteralSecret(secret)) return;
        const host = m[4].toLowerCase();
        const service = host === 'github.com' ? 'github' : undefined;
        out.push(
          hit({
            rule: gitCredentials,
            location: file,
            key: `${host}\u0000${m[2]}`,
            detail: m[2] ? `${m[2]}@${host}` : host,
            storage: 'plaintext',
            value: secret,
            service,
            importable: Boolean(service),
            removal: service ? 'edit' : 'manual',
            edit: service ? { kind: 'drop-line', line } : undefined,
            manualStep: service ? undefined : `Run \`git credential reject\` for ${host}, or remove that line, once nothing needs it.`,
          }),
        );
      });
    }
    return out;
  },
};

/** Codex CLI: `OPENAI_API_KEY` in $CODEX_HOME/auth.json (file storage mode). */
const codexAuth: AmbientRule = {
  id: 'codex-auth',
  tool: 'Codex CLI',
  verifiedFrom:
    'https://learn.chatgpt.com/docs/auth (~/.codex/auth.json or the OS store, cli_auth_credentials_store); openai/codex codex-rs/login/src/auth/storage.rs (AuthDotJson, `OPENAI_API_KEY` field, $CODEX_HOME/auth.json)',
  caveat:
    'With `cli_auth_credentials_store = "keyring"` Codex keeps nothing in the file. A ChatGPT sign-in (`tokens`) is reported but not imported: it is an account session, not an API key.',
  scan(ctx) {
    const p = pathFor(ctx.platform);
    const file = p.join(ctx.env.CODEX_HOME || p.join(ctx.home, '.codex'), 'auth.json');
    const doc = readJson(ctx.readFile(file));
    if (!doc) return [];
    const out: AmbientHit[] = [];
    const key = doc.OPENAI_API_KEY;
    if (typeof key === 'string' && isLiteralSecret(key)) {
      out.push(
        hit({
          rule: codexAuth,
          location: file,
          key: 'OPENAI_API_KEY',
          detail: 'API key',
          storage: 'plaintext',
          value: key,
          service: 'openai',
          removal: 'edit',
          edit: { kind: 'json-key', key: 'OPENAI_API_KEY', to: 'null' },
        }),
      );
    }
    if (doc.tokens && typeof doc.tokens === 'object') {
      out.push(
        hit({
          rule: codexAuth,
          location: file,
          key: 'tokens',
          detail: 'ChatGPT sign-in',
          storage: 'plaintext',
          importable: false,
          removal: 'manual',
          manualStep: 'Set `cli_auth_credentials_store = "keyring"` in Codex config, or run `codex logout`.',
        }),
      );
    }
    return out;
  },
};

/** Find secret-looking assignments in a dotenv or shell file. */
const scanAssignments = (
  rule: AmbientRule,
  ctx: AmbientContext,
  file: string,
  opts: { tool?: string } = {},
): AmbientHit[] => {
  const text = ctx.readFile(file);
  if (text === undefined) return [];
  const out: AmbientHit[] = [];
  for (const a of parseAssignments(text)) {
    const cls = classifyEnvVar(a.name);
    if (!cls || !isLiteralSecret(a.value)) continue;
    out.push(
      hit({
        rule,
        tool: opts.tool,
        location: file,
        key: a.name,
        detail: a.name,
        storage: 'plaintext',
        value: a.value,
        service: cls.service,
        envVar: cls.service ? cls.envVar : a.name,
        ...(a.simple
          ? { removal: 'edit' as const, edit: { kind: 'comment-line' as const, line: a.line, prefix: '#' } }
          : {
              importable: false,
              removal: 'manual' as const,
              manualStep: `Line ${a.line + 1} sets ${a.name} together with other commands. Store the key in Hypergate, then remove the assignment from that line by hand so the rest of it keeps running.`,
            }),
      }),
    );
  }
  return out;
};

/** Gemini CLI's home .env. */
const geminiEnv: AmbientRule = {
  id: 'gemini-env',
  tool: 'Gemini CLI',
  verifiedFrom:
    'https://geminicli.com/docs/get-started/authentication/ (loads the first .env found searching up from the current directory, then the home directory, e.g. ~/.gemini/.env)',
  caveat: 'Only the home-level file is swept; a project `.env` Gemini CLI would find first is not.',
  scan: (ctx) => scanAssignments(geminiEnv, ctx, pathFor(ctx.platform).join(ctx.home, '.gemini', '.env')),
};

/** ~/.env: read by aider (and many dotenv loaders) from the home directory. */
const homeDotenv: AmbientRule = {
  id: 'home-dotenv',
  tool: 'Home .env file',
  verifiedFrom: 'https://aider.chat/docs/config/dotenv.html (aider loads .env from the home directory, the git root, and the current directory)',
  caveat: 'Project-level .env files are not swept; only the one in your home directory.',
  scan: (ctx) => scanAssignments(homeDotenv, ctx, pathFor(ctx.platform).join(ctx.home, '.env')),
};

/** aider's home YAML config: `openai-api-key`, `anthropic-api-key`, and `api-key: [provider=key]`. */
const AIDER_PROVIDER_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};
const aiderConf: AmbientRule = {
  id: 'aider-conf',
  tool: 'aider',
  verifiedFrom:
    'https://aider.chat/docs/config/api-keys.html (openai-api-key, anthropic-api-key, api-key list of provider=key) and https://aider.chat/docs/config/aider_conf.html (home directory, git root, current directory)',
  caveat: 'Only ~/.aider.conf.yml is swept; repo-level copies are not. `api-key` entries map to <PROVIDER>_API_KEY, as aider documents.',
  scan(ctx) {
    const file = pathFor(ctx.platform).join(ctx.home, '.aider.conf.yml');
    const text = ctx.readFile(file);
    if (text === undefined) return [];
    const out: AmbientHit[] = [];
    let inApiKeyList = false;
    const push = (envName: string, value: string, line: number): void => {
      const cls = classifyEnvVar(envName) ?? { envVar: envName };
      out.push(
        hit({
          rule: aiderConf,
          location: file,
          key: envName,
          detail: envName,
          storage: 'plaintext',
          value,
          service: cls.service,
          envVar: cls.service ? cls.envVar : envName,
          removal: 'edit',
          edit: { kind: 'comment-line', line, prefix: '#' },
        }),
      );
    };
    lines(text).forEach((raw, line) => {
      if (/^\s*#/.test(raw)) return;
      const top = /^([a-z][a-z0-9-]*):\s*(.*?)\s*$/.exec(raw);
      if (top) {
        inApiKeyList = top[1] === 'api-key' && top[2] === '';
        const provider = /^(openai|anthropic)-api-key$/.exec(top[1])?.[1];
        const value = unquote(top[2]);
        if (provider && isLiteralSecret(value)) push(AIDER_PROVIDER_ENV[provider], value, line);
        if (top[1] === 'api-key' && top[2]) {
          const inline = /^([a-z0-9_-]+)=(.+)$/i.exec(value);
          if (inline && isLiteralSecret(inline[2])) push(`${inline[1].toUpperCase().replace(/-/g, '_')}_API_KEY`, inline[2], line);
        }
        return;
      }
      if (inApiKeyList) {
        const item = /^\s*-\s*['"]?([a-z0-9_-]+)=([^'"\s]+)['"]?\s*$/i.exec(raw);
        if (item && isLiteralSecret(item[2])) push(`${item[1].toUpperCase().replace(/-/g, '_')}_API_KEY`, item[2], line);
      }
    });
    return out;
  },
};

/** Shell startup files: exported keys any process started from a shell inherits. */
export const shellRcFiles = (ctx: AmbientContext): string[] => {
  const p = pathFor(ctx.platform);
  const h = ctx.home;
  const files = [
    p.join(h, '.zshrc'),
    p.join(h, '.zshenv'),
    p.join(h, '.zprofile'),
    p.join(h, '.bashrc'),
    p.join(h, '.bash_profile'),
    p.join(h, '.profile'),
    p.join(xdgConfig(ctx), 'fish', 'config.fish'),
  ];
  if (ctx.platform === 'win32') {
    files.push(p.join(h, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'));
    files.push(p.join(h, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'));
  } else {
    files.push(p.join(xdgConfig(ctx), 'powershell', 'Microsoft.PowerShell_profile.ps1'));
  }
  return files;
};

const shellRc: AmbientRule = {
  id: 'shell-rc',
  tool: 'Shell startup file',
  verifiedFrom:
    'Shell documentation: zsh (.zshenv/.zprofile/.zshrc), bash (.bash_profile/.bashrc/.profile), fish (config.fish under XDG config), PowerShell ($PROFILE)',
  caveat:
    'Only literal values are reported; `$(...)` and `${...}` references are skipped because they keep no key in the file. A variable here may also be set again somewhere this sweep does not read.',
  scan(ctx) {
    return shellRcFiles(ctx).flatMap((file) => scanAssignments(shellRc, ctx, file));
  },
};

/** The daemon's own environment: a key exported in whatever shell or service manager started it. */
const daemonEnv: AmbientRule = {
  id: 'daemon-env',
  tool: 'Environment',
  verifiedFrom: "process.env of the Hypergate daemon (inherited from whatever started it)",
  caveat:
    "Found in the environment Hypergate itself was started with, which usually means it is exported from a shell startup file or a service manager. Importing copies it into the vault; it stays set until it is removed where it is exported.",
  scan(ctx) {
    const out: AmbientHit[] = [];
    for (const [name, value] of Object.entries(ctx.env)) {
      const cls = classifyEnvVar(name);
      if (!cls?.service || !isLiteralSecret(value)) continue;
      out.push(
        hit({
          rule: daemonEnv,
          location: 'environment',
          key: name,
          detail: name,
          storage: 'environment',
          value,
          service: cls.service,
          envVar: cls.envVar,
          removal: 'manual',
          manualStep: `Remove \`${name}\` where it is exported (a shell startup file, launchd plist, systemd unit, or Windows user environment), then restart Hypergate.`,
        }),
      );
    }
    return out;
  },
};

/**
 * The curated table, in display order: CLIs first, then model-provider harness
 * files, then the generic places a key gets exported from.
 *
 * Deliberately absent (could not be verified from vendor docs or source when
 * this was written, so they are not guessed at): OpenCode's auth store, Gemini
 * CLI's cached Google sign-in, the gcloud `auth login` credential database, and
 * every OS-keyring entry other than GitHub CLI's (which is found through its
 * hosts.yml).
 */
export const AMBIENT_RULES: readonly AmbientRule[] = [
  ghHosts,
  flyConfig,
  vercelAuth,
  supabaseToken,
  npmrc,
  gitCredentials,
  awsCredentials,
  gcloudAdc,
  azureMsal,
  dockerConfig,
  netrc,
  codexAuth,
  geminiEnv,
  aiderConf,
  homeDotenv,
  shellRc,
  daemonEnv,
];

/**
 * Every file the rules could read, for the watcher's cheap mtime gate. Mirrors
 * the rules by running them against a context that records reads.
 */
export const ambientPaths = (ctx: Omit<AmbientContext, 'readFile'>): string[] => {
  const seen = new Set<string>();
  const probe: AmbientContext = {
    ...ctx,
    readFile(path) {
      seen.add(path);
      return undefined;
    },
  };
  for (const rule of AMBIENT_RULES) rule.scan(probe);
  // A rule that returns early on a missing file never asks for its second
  // candidate, so ask for them explicitly.
  for (const f of shellRcFiles(probe)) seen.add(f);
  return [...seen];
};

/** Run every rule. One broken file never hides the others. */
export const scanAmbient = (ctx: AmbientContext, rules: readonly AmbientRule[] = AMBIENT_RULES): AmbientHit[] => {
  const out: AmbientHit[] = [];
  const ids = new Set<string>();
  for (const rule of rules) {
    let hits: AmbientHit[] = [];
    try {
      hits = rule.scan(ctx);
    } catch {
      hits = [];
    }
    for (const h of hits) {
      if (ids.has(h.id)) continue;
      ids.add(h.id);
      out.push(h);
    }
  }
  return out;
};

/**
 * The text of a file with one finding's value taken out, or undefined when the
 * finding is not an in-place edit or the file no longer looks like it did.
 * The marker names the variable and the date, never the value.
 */
export const removeAmbient = (text: string, h: AmbientHit, date: string): string | undefined => {
  const edit = h.edit;
  if (!edit) return undefined;
  if (edit.kind === 'json-key') {
    const doc = readJson(text);
    // The value must still be the one that was scanned (and stored): a login
    // that changed since would otherwise be deleted with only the backup
    // holding the new value.
    if (!doc || !(edit.key in doc) || (h.value !== undefined && doc[edit.key] !== h.value)) return undefined;
    if (edit.to === 'delete') delete doc[edit.key];
    else doc[edit.key] = null;
    return `${JSON.stringify(doc, null, 2)}\n`;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const ls = text.split(/\r?\n/);
  if (edit.line < 0 || edit.line >= ls.length) return undefined;
  // Refuse to edit a line that no longer holds the value we found: the file
  // changed between the scan and the import, and guessing would cut the wrong
  // line out of someone's shell config.
  if (h.value !== undefined && !ls[edit.line].includes(h.value) && !ls[edit.line].includes(encodeURIComponent(h.value)))
    return undefined;
  if (edit.kind === 'drop-line') ls.splice(edit.line, 1);
  else if (edit.kind === 'replace-line') ls[edit.line] = edit.text;
  else {
    const indent = /^\s*/.exec(ls[edit.line])?.[0] ?? '';
    const what = h.detail ?? h.envVar ?? 'credential';
    ls[edit.line] = `${indent}${edit.prefix} hypergate: ${what} moved to the Hypergate vault on ${date}`;
  }
  return ls.join(eol);
};

/** A display name for the vault row an import creates. */
export const ambientCredentialName = (h: AmbientFinding): string => {
  const g = guideName(h.service);
  if (g) return g;
  return h.envVar ?? `${h.tool}${h.detail ? ` (${h.detail})` : ''}`;
};
