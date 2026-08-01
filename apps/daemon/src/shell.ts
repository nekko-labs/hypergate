import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bridge to the `hypergate` shell binary, for the two things Node cannot do
 * itself: OS keychain access and per-platform login items.
 *
 * The daemon never links a keychain or registry library. It shells out to the
 * Rust binary, which owns those APIs, and degrades gracefully to the previous
 * file-based behaviour when the binary is not installed. That keeps the daemon
 * independently runnable (headless Linux, WSL, containers) with no shell at all.
 */

/** Resolved once: the shell binary path, or `undefined` when it is not installed. */
let cached: { path: string | undefined } | undefined;

/**
 * Find the `hypergate` binary: an explicit override, then the platform package
 * beside us, then `PATH`, then the cargo build output for development.
 * Shell-free lookups only.
 */
const locate = (): string | undefined => {
  const override = process.env.HYPERGATE_SHELL_BIN;
  if (override && existsSync(override)) return override;

  const exe = process.platform === 'win32' ? 'hypergate.exe' : 'hypergate';

  // A global npm install, which is the common case and the one PATH cannot
  // answer: `npm bin -g` holds `hypergate.cmd`/`.ps1`/a shell script, never
  // `hypergate.exe` — the real binary lives inside the per-platform optional
  // dependency. Resolve it exactly the way the CLI shim does (see
  // packaging/npm/bin/hypergate.mjs), which works whether npm hoisted the
  // package or nested it.
  try {
    const pkg = `hypergate-shell-${process.platform}-${process.arch}`;
    const candidate = join(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)), 'bin', exe);
    if (existsSync(candidate)) return candidate;
  } catch {
    /* not an npm install, or no build for this platform */
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, exe);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable entry: skip */
    }
  }

  // Development layout: apps/shell/target/{release,debug}/hypergate
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const profile of ['release', 'debug']) {
    const candidate = join(repoRoot, 'apps', 'shell', 'target', profile, exe);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

/** Path to the shell binary, or `undefined`. Memoised. */
export const shellBin = (): string | undefined => {
  if (!cached) cached = { path: locate() };
  return cached.path;
};

/** Is the shell binary available to delegate to? */
export const hasShell = (): boolean => shellBin() !== undefined;

/** Run the shell binary and return stdout, or `undefined` on any failure. */
const run = (args: string[], input?: string): string | undefined => {
  const bin = shellBin();
  if (!bin) return undefined;
  try {
    return execFileSync(bin, args, {
      input,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      // Keychain prompts and errors go to stderr; we never want them on ours.
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    // Non-zero exit is a normal outcome here (e.g. `secret get` on a missing key).
    return undefined;
  }
};

// ── keychain ────────────────────────────────────────────────────────────────

/** Read a secret. `undefined` means absent, or no keychain available. */
export const secretGet = (key: string): string | undefined => {
  const out = run(['secret', 'get', key]);
  return out === undefined || out === '' ? undefined : out;
};

/** Store a secret. Returns whether it was actually stored. */
export const secretSet = (key: string, value: string): boolean =>
  run(['secret', 'set', key], value) !== undefined;

/** Delete a secret. Returns whether the delete was carried out. */
export const secretDelete = (key: string): boolean => run(['secret', 'delete', key]) !== undefined;

/** Is a working OS keychain available on this machine? */
export const keychainAvailable = (): boolean => run(['secret', 'check'])?.trim() === 'available';

// ── autostart (login item) ──────────────────────────────────────────────────

/** Is the login item present? */
export const autostartEnabled = (): boolean => run(['autostart', 'status'])?.trim() === 'enabled';

/** Add or remove the login item. Returns whether the change was applied. */
export const setAutostart = (on: boolean): boolean =>
  run(['autostart', on ? 'on' : 'off']) !== undefined;

// ── updates ─────────────────────────────────────────────────────────────────

/**
 * Hand an update to the shell and return immediately.
 *
 * This cannot be a `run()` call: the updater's whole job is to stop this daemon
 * (and the tray) so the files they run from can be replaced, so waiting for it
 * would mean waiting for our own death. It is spawned detached, with its stdio
 * discarded, and it logs to ~/.hypergate/update.log for anyone who needs to see
 * what happened.
 */
export const startUpdate = (): boolean => {
  const bin = shellBin();
  if (!bin) return false;
  try {
    const child = spawn(bin, ['update', '--apply'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};
