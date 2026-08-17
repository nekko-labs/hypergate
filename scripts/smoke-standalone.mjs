// Smoke test: the standalone daemon, the one an installer ships.
//
// This guards the two things that quietly break it:
//
//   1. The CommonJS bundle. A SEA main script must be CJS, so any top-level
//      await added to the daemon fails the build, and anything relying on a real
//      `import.meta.url` fails at runtime instead. Booting it catches both.
//   2. The durable store. `node:sqlite` is why this is a Node SEA and not a Bun
//      compile (Bun has no such module), and `openStore` degrades silently to
//      in-memory analytics when it is missing. So assert the database exists
//      rather than trusting that it does.
//
//   npm run build:standalone && npm run smoke:standalone
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdown, removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const STANDALONE_DAEMON = join(ROOT, 'dist-standalone', `hypergated${EXE}`);
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const PORT = 7897;
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'hypergate-standalone-'));

const ok = (m) => console.log(`✓ ${m}`);
let daemon;
let dmgMount;
let appPath;
let daemonPath = STANDALONE_DAEMON;
let shellPath = join(ROOT, 'dist-standalone', `hypergate${EXE}`);
let macEntitlementsChecked = false;
const fail = async (m) => {
  console.error(`✗ ${m}`);
  await shutdown(daemon, DIR);
  detachDmg();
  process.exit(1);
};

function detachDmg() {
  if (!dmgMount) return;
  const detached = spawnSync('hdiutil', ['detach', dmgMount], { stdio: 'ignore' });
  if (detached.status !== 0) spawnSync('hdiutil', ['detach', '-force', dmgMount], { stdio: 'ignore' });
  if (dmgMount.startsWith(tmpdir())) {
    try { rmSync(dmgMount, { recursive: true, force: true }); } catch {}
  }
  dmgMount = undefined;
}

function macArchitecture(value) {
  if (!value) return undefined;
  if (value === 'arm64' || value.includes('aarch64')) return 'arm64';
  if (value === 'x64' || value.includes('x86_64')) return 'x86_64';
  return undefined;
}

function runtimeMacArchitecture() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x86_64';
  return process.arch;
}

function assertMacArchitecture(path, label, expected) {
  const result = spawnSync('lipo', ['-archs', path], { encoding: 'utf8' });
  const details = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    return fail(`could not inspect ${label} architecture at ${path}: ${details}`);
  }
  const architectures = details.split(/\s+/).filter(Boolean);
  if (!architectures.includes(expected)) {
    return fail(`${label} architecture is ${architectures.join(', ') || 'unknown'}, expected ${expected}`);
  }
  ok(`${label} architecture ${architectures.join(' ')}, expected ${expected}`);
}

async function prepareDaemon() {
  if (process.platform === 'darwin' && process.env.HYPERGATE_MACOS_DMG) {
    const dmg = process.env.HYPERGATE_MACOS_DMG;
    if (!existsSync(dmg)) {
      await fail(`HYPERGATE_MACOS_DMG does not exist: ${dmg}`);
      return;
    }
    const mount = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', dmg], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const mountLine = (mount.stdout ?? '').split('\n').find((line) => line.includes('/Volumes/'));
    dmgMount = mountLine?.split('\t').at(-1)?.trim();
    if (mount.status !== 0 || !dmgMount) {
      await fail(`could not mount macOS dmg: ${mount.stderr || mount.stdout || 'unknown error'}`);
      return;
    }
    appPath = join(dmgMount, 'Hypergate.app');
    daemonPath = join(appPath, 'Contents', 'MacOS', 'hypergated');
    shellPath = join(appPath, 'Contents', 'MacOS', 'hypergate');
    const seal = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], {
      encoding: 'utf8',
    });
    if (seal.status !== 0) {
      await fail(`macOS app bundle signature is invalid: ${seal.stderr ?? seal.stdout ?? 'unknown error'}`);
      return;
    }
    ok('macOS app bundle has a valid strict code-signing seal');
    const background = join(appPath, 'Contents', 'Resources', 'dmg-background.png');
    const store = join(dmgMount, '.DS_Store');
    if (!existsSync(background) || !existsSync(store)) {
      await fail('macOS dmg is missing its background or Finder layout');
      return;
    }
    ok('macOS dmg contains its branded background and Finder layout');
    const layout = spawnSync('osascript', ['-', `Hypergate ${VERSION}`], {
      input: `on run argv
  set volumeName to item 1 of argv
  tell application "Finder"
    set dmgDisk to disk volumeName
    tell dmgDisk
      open
      delay 1
      set dmgWindow to container window
      set windowBounds to bounds of dmgWindow
      set windowWidth to (item 3 of windowBounds) - (item 1 of windowBounds)
      set windowHeight to (item 4 of windowBounds) - (item 2 of windowBounds)
      set summary to (windowWidth as text) & "," & (windowHeight as text) & "," & ((toolbar visible of dmgWindow) as text) & "," & ((statusbar visible of dmgWindow) as text) & "," & ((pathbar visible of dmgWindow) as text) & "," & ((sidebar width of dmgWindow) as text) & "," & ((current view of dmgWindow is icon view) as text)
      close dmgWindow
      return summary
    end tell
  end tell
end run`,
      encoding: 'utf8',
    });
    const [width, height, toolbar, statusbar, pathbar, sidebar, iconView] = (layout.stdout ?? '').trim().split(',');
    if (
      layout.status !== 0 ||
      width !== '660' ||
      Number(height) < 400 ||
      Number(height) > 440 ||
      toolbar !== 'false' ||
      statusbar !== 'false' ||
      pathbar !== 'false' ||
      sidebar !== '0' ||
      iconView !== 'true'
    ) {
      await fail(`macOS dmg Finder layout is wrong: ${layout.stderr || layout.stdout || 'no layout result'}`);
      return;
    }
    ok(`macOS dmg opens at ${width}×${height} with Finder chrome hidden`);
    if (process.env.HYPERGATE_MACOS_GATEKEEPER === '1') {
      const assessment = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], {
        encoding: 'utf8',
      });
      if (assessment.status !== 0) {
        await fail(`Gatekeeper rejected the macOS app: ${assessment.stderr ?? assessment.stdout ?? 'unknown error'}`);
        return;
      }
      ok('Gatekeeper accepts the macOS app');
    }
  }
  if (!existsSync(daemonPath)) {
    await fail(`${daemonPath} is missing, so run \`npm run build:standalone\` first`);
    return;
  }
  const configuredTarget = process.env.HYPERGATE_TARGET_ARCH;
  const expected = macArchitecture(configuredTarget);
  if (configuredTarget && !expected) {
    await fail(`unsupported HYPERGATE_TARGET_ARCH: ${configuredTarget}`);
    return;
  }
  if (process.platform === 'darwin' && expected) {
    await assertMacArchitecture(daemonPath, 'macOS daemon', expected);
    if (!existsSync(shellPath)) {
      await fail(`${shellPath} is missing, so the macOS shell architecture cannot be checked`);
      return;
    }
    await assertMacArchitecture(shellPath, 'macOS shell', expected);
  } else if (process.platform === 'darwin') {
    ok('macOS architecture check skipped (set HYPERGATE_TARGET_ARCH to assert a target)');
  }
  if (process.platform !== 'darwin') {
    ok('macOS daemon signature check skipped (not running on macOS)');
  } else if (!process.env.HYPERGATE_MACOS_DMG) {
    ok('macOS daemon signature check skipped (no DMG configured; local build may be unsigned)');
  } else {
    const signature = spawnSync('codesign', ['-d', '--entitlements', ':-', daemonPath], {
      encoding: 'utf8',
    });
    const details = `${signature.stdout ?? ''}${signature.stderr ?? ''}`;
    if (signature.status !== 0) {
      await fail(`codesign could not inspect ${daemonPath}: ${details}`);
      return;
    }
    for (const entitlement of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
    ]) {
      if (!details.includes(`<key>${entitlement}</key>`)) {
        await fail(`macOS daemon is missing entitlement ${entitlement}: ${details}`);
        return;
      }
    }
    macEntitlementsChecked = true;
    ok('macOS daemon signature contains the V8 entitlements');
  }
}

await prepareDaemon();

const expectedMacArchitecture = macArchitecture(process.env.HYPERGATE_TARGET_ARCH);
const runnerMacArchitecture = runtimeMacArchitecture();
if (
  process.platform === 'darwin'
  && expectedMacArchitecture
  && runnerMacArchitecture !== expectedMacArchitecture
) {
  await shutdown(undefined, DIR);
  detachDmg();
  ok(
    `daemon execution skipped: ${expectedMacArchitecture} artifact on ${runnerMacArchitecture} runner; `
      + `static architecture checks passed${macEntitlementsChecked ? ' and entitlement checks passed' : '; entitlement check skipped for unsigned artifact'}`,
  );
  console.log('\nStandalone daemon smoke: static checks green; execution skipped for cross-architecture artifact');
  process.exit(0);
}

// No `node` anywhere in this command: that is the whole point of the artifact.
daemon = spawn(daemonPath, [], {
  env: { ...process.env, HYPERGATE_DIR: DIR, HYPERGATE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
daemon.stderr.on('data', (d) => process.stderr.write(d));

let up = false;
for (let i = 0; i < 75 && !up; i++) {
  up = await fetch(`${BASE}/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) await fail('the standalone daemon did not come up');

const health = await (await fetch(`${BASE}/health`)).json();
if (health.version !== VERSION) await fail(`version was ${health.version}, expected ${VERSION}`);
ok(`standalone daemon up, no Node installed required (v${health.version})`);

// The UI is found relative to process.execPath in this layout, not relative to
// a module path, since there are no modules on disk.
const html = await (await fetch(`${BASE}/`)).text();
if (!html.includes('<div id="root">')) await fail(`the web UI was not served: ${html.slice(0, 160)}`);
ok('serves the web UI from beside the executable');

// The durable store: absent means node:sqlite was unavailable and history would
// silently be in-memory only.
if (!existsSync(join(DIR, 'hypergate.db'))) await fail('no hypergate.db, so the durable store did not open');
ok('opened the SQLite store');

// Spawning a child MCP server exercises the bundled cross-spawn and the
// `require` shim the ESM/CJS bundle needs.
const added = await (
  await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'echo',
      name: 'Echo',
      runtime: 'process',
      command: process.execPath,
      args: [join(ROOT, 'packages/core/src/fixtures/echo-server.mjs')],
      enabled: true,
    }),
  })
).json();
if (added.state !== 'ready') await fail(`echo server not ready: ${JSON.stringify(added)}`);
ok('launched and connected a managed MCP server');

const gw = await (await fetch(`${BASE}/api/gateway`)).json();
const call = await (
  await fetch(gw.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${gw.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo__echo', arguments: { text: 'no runtime required' } },
    }),
  })
).json();
if (call?.result?.content?.[0]?.text !== 'no runtime required') {
  await fail(`tools/call through the gateway returned ${JSON.stringify(call)}`);
}
ok('routed a tool call through the gateway');

await shutdown(daemon, DIR);
detachDmg();
console.log('\nStandalone daemon smoke: all green');
process.exit(0);
