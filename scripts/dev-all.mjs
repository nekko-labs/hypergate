// `npm run dev`: the daemon and the manager together, from what is on disk.
//
// 1. After a pull, installs when package-lock.json changed.
// 2. Builds @hypergate/shared and @hypergate/core and keeps them rebuilding
//    (`tsc --watch`), because the daemon imports their dist/: a stale build
//    is what "does not provide an export named ..." after a pull means.
// 3. Starts the daemon (`node --watch`, restarts on save) and the manager
//    (Vite, hot reload), prefixes their output, and once both are up prints
//    the banner: what runs where, and the keys.
//
// Keys (in a terminal): q or Enter stops everything it started, Ctrl+C the
// same (twice to force), r restarts from what is on disk, o opens the manager.
// HYPERGATE_OPEN=0 (or CI) skips opening the browser; HYPERGATE_PORT and
// HYPERGATE_DIR run the daemon on its own port and data dir (point the
// manager at it with HYPERGATE_DEV_API). Dependency-free.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devBanner, staleBuildHint } from './dev-banner.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (s) => process.stdout.write(`${paint('2', '[dev]')} ${s}\n`);
// In a terminal the launcher reads its keys; elsewhere (CI, an IDE task)
// Ctrl+C still works. HYPERGATE_DEV_KEYS=1 reads keys from piped stdin too.
const keys = Boolean(process.stdin.isTTY) || process.env.HYPERGATE_DEV_KEYS === '1';
// Under scripts/dev.mjs (npm run dev), which starts a fresh launcher on r.
const looped = process.env.HYPERGATE_DEV_LOOP === '1';

// ── 1. dependencies ─────────────────────────────────────────────────────────
const lock = join(root, 'package-lock.json');
const installed = join(root, 'node_modules', '.package-lock.json');
if (!existsSync(installed) || statSync(lock).mtimeMs > statSync(installed).mtimeMs) {
  say('package-lock.json changed since the last install: installing...');
  // npm's own CLI through node when `npm run dev` started us: no shell needed.
  // --no-save: never rewrite package-lock.json, so a dev run leaves the tree clean.
  const args = ['install', '--no-save', '--no-audit', '--no-fund'];
  const r = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync(npm, args, { cwd: root, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    say(paint('31', 'npm install failed; fix that first.'));
    process.exit(r.status ?? 1);
  }
}

// ── processes ───────────────────────────────────────────────────────────────
const children = [];
let stopping = false;
let restarting = false;
let forced = false;

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
/** A package's `tsc --watch`, quiet unless something fails to compile. */
const watcher = (name, pkg) => ({
  name,
  color: '33',
  cmd: process.execPath,
  args: [tsc, '-p', join(root, 'packages', pkg, 'tsconfig.json'), '--watch', '--preserveWatchOutput'],
  shell: false,
  quiet: (line) => !/error|Found [1-9]\d* errors?/i.test(line),
});
// Started directly rather than through `npm run` (what dev:daemon and dev:web
// run), so there are no npm layers to print banners or to outlive a stop.
const daemon = {
  name: 'daemon',
  color: '35',
  cwd: join(root, 'apps', 'daemon'),
  cmd: process.execPath,
  args: ['--watch', '--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/index.ts'],
  shell: false,
};
const vite = join(createRequire(join(root, 'apps', 'web', 'package.json')).resolve('vite/package.json'), '..', 'bin', 'vite.js');
const web = { name: 'web', color: '36', cwd: join(root, 'apps', 'web'), cmd: process.execPath, args: [vite], shell: false };

/** Start one process; `onLine` sees each line of its output, colours stripped. */
function start(p, onLine) {
  const child = spawn(p.cmd, p.args, {
    cwd: p.cwd ?? root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: p.shell,
    // Its own process group off Windows, so stopping reaches what it started.
    detached: !isWin,
  });
  child.label = p.name;
  const tag = `${paint(p.color, `[${p.name}]`)} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
        if (!(p.quiet?.(plain) || (p.quiet && !plain.trim()))) out.write(`${tag}${line}\n`);
        // After the line itself, so the banner follows "hypergated up", not the other way round.
        onLine?.(plain);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      say(`${p.name} exited (${code ?? 'killed'}); stopping the rest.`);
      stop();
    }
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) finish();
  });
  children.push(child);
  return child;
}

/** End a process and everything it started. */
function kill(child, force) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) {
    // Console processes ignore a polite close on Windows: end the whole tree.
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}

const STOP_GRACE_MS = 5000;
function stop() {
  if (stopping) {
    if (!forced) {
      forced = true;
      say('Forcing stop.');
      for (const c of children) kill(c, true);
    }
    return;
  }
  stopping = true;
  say(restarting ? 'Restarting: stopping everything first...' : 'Stopping Hypergate dev... (press again to force)');
  for (const c of children) kill(c, false);
  setTimeout(() => {
    if (children.some((c) => c.exitCode === null && c.signalCode === null)) {
      say('Still running; forcing stop.');
      forced = true;
      for (const c of children) kill(c, true);
    }
  }, STOP_GRACE_MS).unref();
  if (children.length === 0) finish();
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  if (keys && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* not a TTY any more */
    }
  }
  process.stdin.pause();
  if (restarting) {
    // scripts/dev.mjs starts a fresh launcher on this code (its RESTART). Run
    // directly, there is no loop: say how to start again instead.
    if (looped) {
      say('Restarting with what is on disk...');
      process.exit(75);
    }
    say('Stopped. Run npm run dev to start again (restart needs it).');
    process.exit(0);
  }
  say('Stopped.');
  process.exit(0);
}

process.on('SIGINT', () => {
  restarting = false;
  stop();
});
process.on('SIGTERM', () => {
  restarting = false;
  stop();
});
process.on('exit', () => {
  for (const c of children) kill(c, true);
});

if (keys) {
  // Raw mode: Ctrl+C arrives as a key here rather than as a signal.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    const key = data.toString().replace(/\n$/, '');
    if (key === '\x03' || key === '\r' || key === '' || key.toLowerCase() === 'q') {
      restarting = false;
      stop();
    } else if (key.toLowerCase() === 'r' && !stopping) {
      if (!looped) {
        say('Restart works under npm run dev; this run was started directly.');
        return;
      }
      restarting = true;
      stop();
    } else if (key.toLowerCase() === 'o') {
      if (managerUrl) openBrowser(managerUrl, true);
      else say('The manager is not up yet.');
    }
  });
}

// ── browser ─────────────────────────────────────────────────────────────────
const noOpen = process.env.HYPERGATE_OPEN === '0' || process.env.CI;
let opened = false;
function openBrowser(url, asked = false) {
  if (!asked && (opened || noOpen)) return;
  opened = true;
  const [cmd, args] = isWin
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best effort; the URL is in the banner */
  }
}

// ── 2. shared and core, built and watched ───────────────────────────────────
/** Resolves once a watcher's first compile has finished. */
const watchUntilBuilt = (p) =>
  new Promise((resolve) => {
    let done = false;
    start(p, (line) => {
      const m = line.match(/Found (\d+) errors?\. Watching for file changes/);
      if (m && !done) {
        done = true;
        if (m[1] !== '0') say(paint('31', `${p.name} has ${m[1]} type error(s) (above); the daemon may not start until they are fixed.`));
        resolve();
      }
    });
  });

say('Building @hypergate/shared and @hypergate/core (they rebuild on save)...');
await watchUntilBuilt(watcher('shared', 'shared'));
if (!stopping) await watchUntilBuilt(watcher('core', 'core'));

// ── 3. daemon and manager ───────────────────────────────────────────────────
let gatewayUrl;
let managerUrl;
let bannerShown = false;
let hinted = false;
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(root, 'apps', 'daemon', 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
})();
const maybeBanner = () => {
  if (bannerShown || !gatewayUrl || !managerUrl || stopping) return;
  bannerShown = true;
  process.stdout.write(
    devBanner({
      version,
      manager: managerUrl,
      gateway: gatewayUrl,
      dataDir: process.env.HYPERGATE_DIR || join(homedir(), '.hypergate'),
      scratch: Boolean(process.env.HYPERGATE_DIR),
      keys,
      restart: looped,
      color,
    }) + '\n',
  );
};

if (!stopping) {
  start(daemon, (line) => {
    const up = line.match(/hypergated up .*?(https?:\/\/\S+)/);
    if (up) {
      gatewayUrl = `${up[1].replace(/\/$/, '')}/mcp`;
      hinted = false;
      maybeBanner();
    }
    if (!hinted) {
      const hint = staleBuildHint(line);
      if (hint) {
        hinted = true;
        say(paint('33', hint));
      } else if (/EADDRINUSE/.test(line)) {
        hinted = true;
        const port = process.env.HYPERGATE_PORT || '7777';
        say(
          paint(
            '33',
            `Port ${port} is taken, most likely by your installed Hypergate. Quit it from its tray icon, or run on another port: HYPERGATE_PORT=7790 HYPERGATE_DEV_API=http://localhost:7790 npm run dev`,
          ),
        );
      }
    }
  });
  start(web, (line) => {
    const m = line.match(/Local:\s*(https?:\/\/\S+)/);
    if (m && !managerUrl) {
      managerUrl = m[1];
      openBrowser(managerUrl);
      maybeBanner();
    }
  });
  if (keys) say(`Press q or Enter to stop (twice to force)${looped ? ', r to restart after a pull' : ''}, o to open the manager.`);
}
