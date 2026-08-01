import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';

import * as shell from './shell.ts';

/**
 * "Launch Hypergate when I sign in", on every platform, with or without the
 * desktop shell installed.
 *
 * The `hypergate` binary already implements login items properly (in-process
 * registry calls on Windows, a LaunchAgent on macOS, an XDG entry on Linux), so
 * when it is there we delegate and inherit all of that. But it is optional —
 * `npm i -g hypergated`, a container, WSL, and a repo checkout all give you a
 * daemon and no shell — and until now that made the toggle permanently dead
 * ("autostart isn't wired up on win32 yet"), which is a worse answer than doing
 * the small amount of work ourselves.
 *
 * So: same three mechanisms, written from Node when there is no shell to ask.
 * Always per-user, never elevated, never a system service — a managed MCP server
 * needs the user's PATH, home dir, npx cache and keychain, which is the whole
 * reason Hypergate is a logon agent (see SPEC §1.1).
 */

/** Registry value / LaunchAgent label / desktop-entry basename. One name everywhere. */
const NAME = 'Hypergate';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const MAC_LABEL = 'app.hypergate.daemon';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

/** Who would write the login item: the shell binary, us, or nobody. */
export type StartupVia = 'shell' | 'daemon' | 'none';

/**
 * What a login item should launch.
 *
 * The tray is the better answer when it exists — it supervises the daemon, puts
 * an icon in the notification area, and is what the desktop app *is*. Without
 * it we start the daemon directly, which is the honest equivalent: the gateway
 * comes up at login, there is simply no tray to click.
 */
const launchArgv = (): string[] | undefined => {
  const bin = shell.shellBin();
  if (bin) return [bin, 'tray'];

  // A globally-installed `hypergated` is a real executable on PATH; prefer it,
  // because it keeps working when this checkout moves or node is upgraded.
  const onPath = resolveOnPath(process.platform === 'win32' ? 'hypergated.exe' : 'hypergated');
  if (onPath) return [onPath];

  // The compiled standalone daemon: the running executable *is* hypergated,
  // and there is no script path to point at.
  const exe = process.execPath;
  const base = exe.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (base.startsWith('hypergated')) return [exe];

  // Last resort: re-run this module the way it is running now, flags included
  // (`--experimental-strip-types` matters for a checkout).
  const script = process.argv[1];
  if (!script) return undefined;
  return [exe, ...process.execArgv, script];
};

/** Absolute path for a bare command name on PATH, or undefined. Shell-free. */
const resolveOnPath = (file: string): string | undefined => {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, file);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable entry: skip */
    }
  }
  return undefined;
};

/** The login-item command as one displayable string (quoted where it needs it). */
export const startupCommand = (): string | undefined => {
  const argv = launchArgv();
  if (!argv) return undefined;
  return argv.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(' ');
};

/** Who handles autostart here. `none` when we cannot work out what to launch. */
export const via = (): StartupVia => {
  if (shell.hasShell()) return 'shell';
  return launchArgv() ? 'daemon' : 'none';
};

/** Is autostart available at all on this machine? */
export const supported = (): boolean => via() !== 'none';

// ── Windows: the HKCU Run key, via reg.exe ──────────────────────────────────
// The shell does this with in-process registry calls; from Node there is no
// registry API, so `reg.exe` it is — spawned shell-free with `windowsHide`, and
// only ever on an explicit user action or a settings read, never on a poll.
const regRun = (args: string[]): string | undefined => {
  try {
    return execFileSync('reg.exe', args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // A missing value exits non-zero; that is an answer, not a failure.
    return undefined;
  }
};

// ── macOS: a per-user LaunchAgent ───────────────────────────────────────────
const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
const xmlEsc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// ── Linux: an XDG autostart entry ───────────────────────────────────────────
const desktopPath = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'hypergate.desktop');
/** Desktop Entry `Exec=` is unquoted-with-escapes: backslash and space escape. */
const execEsc = (s: string): string => s.replaceAll('\\', '\\\\').replaceAll(' ', '\\ ');

/** Is the login item present right now? Reads real OS state, never a cached preference. */
export const enabled = (): boolean => {
  if (shell.hasShell()) return shell.autostartEnabled();
  if (WIN) return regRun(['query', RUN_KEY, '/v', NAME]) !== undefined;
  if (MAC) return existsSync(plistPath());
  return existsSync(desktopPath());
};

/** Add or remove the login item. Throws with a reason the UI can show. */
export const set = (on: boolean): void => {
  if (shell.hasShell()) {
    if (!shell.setAutostart(on)) throw new Error('the hypergate shell could not change the login item');
    return;
  }
  const argv = launchArgv();
  if (!argv) throw new Error('could not work out what to launch at login on this install');

  if (WIN) {
    if (!on) {
      // Deleting a value that isn't there is success: this must be idempotent.
      if (regRun(['query', RUN_KEY, '/v', NAME]) !== undefined && regRun(['delete', RUN_KEY, '/v', NAME, '/f']) === undefined)
        throw new Error('could not remove the Run key value');
      return;
    }
    if (regRun(['add', RUN_KEY, '/v', NAME, '/t', 'REG_SZ', '/d', startupCommand()!, '/f']) === undefined)
      throw new Error('could not write the Run key value');
    return;
  }

  if (MAC) {
    const path = plistPath();
    if (!on) {
      if (existsSync(path)) rmSync(path);
      return;
    }
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    const args = argv.map((a) => `    <string>${xmlEsc(a)}</string>`).join('\n');
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`,
    );
    return;
  }

  const path = desktopPath();
  if (!on) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `[Desktop Entry]
Type=Application
Name=${NAME}
Comment=Local-first runtime and gateway for MCP servers
Exec=${argv.map(execEsc).join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`,
  );
};

/** The raw argv a login item would run. Exported for tests and diagnostics. */
export const launchCommandArgv = launchArgv;
