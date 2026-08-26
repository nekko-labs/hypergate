import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Recovering the user's real `PATH` when the OS started the daemon.
 *
 * ## The problem
 *
 * A process launched by launchd (the macOS login item) or by a desktop session
 * does not inherit the shell's environment, because no shell was involved. It
 * gets a stub:
 *
 *     PATH=/usr/bin:/bin:/usr/sbin:/sbin
 *
 * Nothing installed by Homebrew, nvm, cargo, bun or uv is on it. For Hypergate
 * that is not cosmetic: the same `PATH` answers *three* different questions.
 *
 * 1. **Which CLIs does this machine have?** The PATH scan reported 1 of 23 on a
 *    Mac that had all of them, and `hypergate__clis_list` told every connected
 *    agent the machine had no node, no npm and no docker.
 * 2. **Which install route can run here?** A missing `brew` ranks below the
 *    vendor's script (see `rankInstall`), so Homebrew silently stopped being
 *    offered to people who have it.
 * 3. **Can a managed server start?** `baseEnv()` in core's runtime.ts copies
 *    `process.env.PATH` into every stdio child, so an `npx` or `uvx` server
 *    cannot spawn at all. This is the one that breaks work rather than looks
 *    wrong, and it hides until someone adds a local server.
 *
 * ## The approach
 *
 * Ask the user's login shell, exactly as VS Code and Docker Desktop do, because
 * it is the only source that knows about nvm, asdf, or a hand-edited profile.
 * Guarded so it costs nothing in the common case:
 *
 * - **Only when the current `PATH` looks like a stub.** Started from a terminal,
 *   the environment is already right and we must not second-guess it.
 * - **Bounded and best-effort.** An interactive shell runs the user's rc files,
 *   which can be slow or, in the worst case, block; the call is killed after a
 *   timeout and simply yields nothing.
 * - **Sentinel-delimited output**, since an interactive shell may print banners,
 *   version notices or fortune cookies around our answer.
 * - **A fallback that still helps.** If the shell cannot answer, the well-known
 *   install directories that actually exist on this machine are better than the
 *   four launchd offered.
 *
 * Everything here is pure except `loginShellPath`, so the merge rules and the
 * stub detection are unit-tested without spawning anything.
 */

/** Exactly what launchd hands a GUI process, and the closest Linux equivalents. */
const STUB_PATHS = ['/usr/bin:/bin:/usr/sbin:/sbin', '/usr/bin:/bin', '/bin:/usr/bin'];

/** Sentinels around the answer, so a chatty rc file cannot be mistaken for it. */
const MARK_START = '__hypergate_path_start__';
const MARK_END = '__hypergate_path_end__';

/**
 * Is this the environment of a process the OS launched rather than a shell?
 *
 * Deliberately conservative: only the known stubs, plus the case of a `PATH`
 * with no directory outside the system ones. A user whose real `PATH` is
 * genuinely just the system directories loses nothing by us asking their shell
 * and getting the same answer back.
 */
export function looksLikeStubPath(path: string | undefined): boolean {
  const value = (path ?? '').trim().replace(/:+$/, '');
  if (!value) return true;
  if (STUB_PATHS.includes(value)) return true;
  const system = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  return value.split(delimiter).filter(Boolean).every((dir) => system.has(dir));
}

/**
 * Where tools land when they are not in the system directories. Only ones that
 * exist are returned: a `PATH` full of absent directories slows every lookup in
 * every child process for no benefit.
 */
export function wellKnownDirs(
  opts: { home?: string; platform?: string; exists?: (p: string) => boolean } = {},
): string[] {
  const { home = homedir(), platform = process.platform, exists = existsSync } = opts;
  const mac = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/opt/local/bin'];
  const linux = ['/home/linuxbrew/.linuxbrew/bin', '/snap/bin'];
  const shared = ['/usr/local/bin', '/usr/local/sbin'];
  const underHome = ['.local/bin', '.cargo/bin', '.bun/bin', '.deno/bin', '.volta/bin', 'go/bin'];
  return [
    ...(platform === 'darwin' ? mac : platform === 'linux' ? linux : []),
    ...shared,
    ...underHome.map((rel) => join(home, ...rel.split('/'))),
  ].filter(exists);
}

/** Append directories that are not already present, keeping the existing order. */
export function mergePath(current: string | undefined, extra: string[]): string {
  const have = new Set((current ?? '').split(delimiter).filter(Boolean));
  const out = [...have];
  for (const dir of extra) {
    if (dir && !have.has(dir)) {
      have.add(dir);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}

/** Pull the answer out of whatever the shell printed around it. */
export function parseShellPath(output: string): string | undefined {
  const start = output.indexOf(MARK_START);
  if (start === -1) return undefined;
  const from = start + MARK_START.length;
  const end = output.indexOf(MARK_END, from);
  if (end === -1) return undefined;
  const value = output.slice(from, end).trim();
  return value || undefined;
}

/**
 * The user's `PATH` according to their login shell, or undefined.
 *
 * `-i` and `-l` are both needed and neither is enough: `-l` sources the profile
 * files (`.zprofile`, `.bash_profile`) and `-i` the interactive ones (`.zshrc`),
 * and people put `PATH` edits in either. Never throws, never hangs past the
 * timeout, and never inherits our own `PATH` so a stub cannot echo back.
 */
export async function loginShellPath(
  opts: { shell?: string; timeoutMs?: number; run?: typeof execFile } = {},
): Promise<string | undefined> {
  const { shell = process.env.SHELL, timeoutMs = 3000, run = execFile } = opts;
  if (!shell || !/^\/[\w./-]+$/.test(shell)) return undefined;
  const script = `printf '%s%s%s' '${MARK_START}' "$PATH" '${MARK_END}'`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value?: string): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = run(
        shell,
        ['-ilc', script],
        { timeout: timeoutMs, maxBuffer: 1_000_000, killSignal: 'SIGKILL', windowsHide: true },
        (_err, stdout) => done(parseShellPath(String(stdout ?? ''))),
      );
      // A shell that ignores SIGKILL-on-timeout, or a `run` that never calls
      // back, must not leave boot waiting on this forever.
      const guard = setTimeout(() => {
        child?.kill?.('SIGKILL');
        done(undefined);
      }, timeoutMs + 500);
      guard.unref?.();
    } catch {
      done(undefined);
    }
  });
}

/** What produced the PATH the daemon ended up with, for the boot log. */
export type PathSource = 'inherited' | 'login-shell' | 'well-known';

/**
 * The `PATH` this daemon should use, and where it came from.
 *
 * Returns the inherited value untouched unless it looks like an OS stub, so the
 * usual `hypergated` run from a terminal pays nothing and behaves exactly as it
 * always has. The well-known directories are merged in either way once we are
 * repairing, since a login shell that answers may still omit a directory the
 * user installed into but never added to their profile.
 */
export async function resolveUserPath(
  opts: {
    current?: string;
    platform?: string;
    home?: string;
    exists?: (p: string) => boolean;
    shellPath?: () => Promise<string | undefined>;
  } = {},
): Promise<{ path: string; source: PathSource }> {
  const {
    current = process.env.PATH,
    platform = process.platform,
    home,
    exists,
    shellPath = loginShellPath,
  } = opts;
  // Windows GUI processes get the user's full PATH from the registry, so there
  // is nothing to repair and no login shell to ask.
  if (platform === 'win32' || !looksLikeStubPath(current)) {
    return { path: current ?? '', source: 'inherited' };
  }
  const known = wellKnownDirs({ home, platform, exists });
  const fromShell = await shellPath();
  if (fromShell && !looksLikeStubPath(fromShell)) {
    return { path: mergePath(fromShell, known), source: 'login-shell' };
  }
  return { path: mergePath(current, known), source: 'well-known' };
}
