import { execFileSync, spawn } from 'node:child_process';
import type { AuthorizeCapability } from '@hypergate/shared';
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
export const startUpdate = (onError?: (error: string) => void): boolean => {
  const bin = shellBin();
  if (!bin) return false;
  try {
    const child = spawn(bin, ['update', '--apply'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', (error) => onError?.(`the update process could not start: ${error.message}`));
    child.unref();
    return true;
  } catch {
    return false;
  }
};

// ── proving who is at the keyboard ──────────────────────────────────────────

/** One verdict from the `authorize` subcommand. */
export interface AuthorizeVerdict {
  authorized: boolean;
  reason?: 'denied' | 'unavailable' | 'error';
  detail?: string;
}

/**
 * Turn the shell's exit code into a verdict.
 *
 * Split out and exported because getting this wrong is invisible and
 * user-facing. The contract is `authorize.rs`'s: 0 authorized, 1 denied, 3 no
 * prompt available on this machine.
 *
 * The case that forced this to be its own function is **exit 2**: clap's usage
 * error, which is what an *older* `hypergate` binary returns for a subcommand
 * it has never heard of. Every install that updates the daemon before the shell
 * binary hits it, and mapping it to `denied` told those users "you were
 * refused" when the truth was "the thing that asks is out of date". Anything we
 * do not recognise is `unavailable`, because not knowing is not the same as
 * being told no, and only `denied` should read as a refusal.
 */
export const verdictFromExit = (code: number | null, stderr: string): AuthorizeVerdict => {
  const detail = stderr.trim() || undefined;
  if (code === 0) return { authorized: true };
  if (code === 1) return { authorized: false, reason: 'denied', detail };
  if (code === 3) return { authorized: false, reason: 'unavailable', detail };
  // Killed by our own timeout, or died on a signal.
  if (code === null) return { authorized: false, reason: 'error', detail };
  if (code === 2)
    return {
      authorized: false,
      reason: 'unavailable',
      detail:
        detail ??
        'this hypergate binary does not support "authorize" — update the Hypergate app or CLI to reveal values',
    };
  return { authorized: false, reason: 'unavailable', detail: detail ?? `the authorize command exited ${code}` };
};

/**
 * Ask the OS to confirm the person at the keyboard, for the vault's reveal
 * door.
 *
 * `run()` is deliberately not used here. Its 10 second timeout is right for a
 * keychain read and wrong for a prompt a human has to notice, read, and answer
 * with a fingerprint; and its `stdio: ignore` for stderr would throw away the
 * only explanation we get when no prompt is available. So this spawns with a
 * generous timeout of its own and keeps stderr.
 *
 * Fails closed everywhere: no shell binary, a crash, a timeout, or an exit code
 * we do not recognise all come back unauthorized. The only path to
 * `authorized: true` is exit code 0 from a binary that got a real answer from
 * LocalAuthentication, Windows Hello, or polkit.
 */
export const authorize = async (reason: string): Promise<AuthorizeVerdict> => {
  const bin = shellBin();
  if (!bin) return { authorized: false, reason: 'unavailable', detail: 'the hypergate shell binary is not installed' };
  return await new Promise((resolvePromise) => {
    const child = spawn(bin, ['authorize', '--reason', reason], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    // Long enough for someone to walk back to their desk; short enough that a
    // wedged prompt does not hold an HTTP connection open forever.
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ authorized: false, reason: 'error', detail: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(verdictFromExit(code, stderr));
    });
  });
};

/**
 * What kind of consent prompt this machine can show, for the UI to key off.
 *
 * A silent failure here has two quite different causes and the message has to
 * cover both: there is no `hypergate` binary at all, or there is one that
 * predates the `authorize` subcommand (which is the common case right after an
 * update, since the daemon and the shell are separately installed artifacts).
 * Either way the answer is the same and the reveal button stays off.
 */
export const authorizeCapability = (): AuthorizeCapability => {
  if (!hasShell()) return { available: false, method: 'none', detail: 'the hypergate shell binary is not installed' };
  const out = run(['authorize', '--check'])?.trim();
  if (!out)
    return {
      available: false,
      method: 'none',
      detail: 'this hypergate binary is too old to ask for confirmation — update the Hypergate app or CLI',
    };
  const [method, ...rest] = out.split(' ');
  if (method === 'touch-id' || method === 'windows-hello' || method === 'polkit')
    return { available: true, method };
  return { available: false, method: 'none', detail: rest.join(' ') || undefined };
};
