// Smoke test for update awareness and the one-click update.
//
// Nothing is published to npm yet, so this cannot install a real release. What it
// can do is prove every moving part against a stub feed and a fake `npm`:
//
//   • the daemon knows it was installed with npm (channel detection) from a real
//     node_modules layout, copied out of dist-npm/ rather than pretended at;
//   • a check finds the newer version, caches it for a day, and `force` refetches;
//   • apply is refused without the master token and from another origin;
//   • the accepted one really does stop the daemon, run
//     `npm install -g hypergated@<new>`, and log what happened.
//
// The fake npm records its argv instead of installing anything, and the relaunch
// is switched off (HYPERGATE_UPDATE_RELAUNCH=0) so a test never leaves a tray
// icon or an app window behind.
//
//   npm run build:npm && npm run smoke:update
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-npm');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NEWER = '99.0.0';
const PORT = 7895;
// Deliberately NOT PORT + 1: that is the tray's single-instance lock port, and
// `update --apply` treats anything listening there as a running agent to quit.
const FEED_PORT = 7921;
const BASE = `http://localhost:${PORT}`;
const PROJECT = mkdtempSync(join(tmpdir(), 'hypergate-update-'));
const DATA = join(PROJECT, 'data');
const BIN = join(PROJECT, 'fakebin');
const NPM_LOG = join(PROJECT, 'npm-argv.txt');
const shellPkg = `hypergate-shell-${process.platform}-${process.arch}`;
const WIN = process.platform === 'win32';

const ok = (m) => console.log(`✓ ${m}`);
let daemon;
let feed;
const cleanup = () => {
  try {
    daemon?.kill();
  } catch {
    /* already gone */
  }
  try {
    feed?.close();
  } catch {
    /* not listening */
  }
  removeDir(PROJECT);
};
const fail = (m) => {
  console.error(`✗ ${m}`);
  cleanup();
  process.exit(1);
};

// ── an npm-shaped install, from the real packaged output ─────────────────────
for (const pkg of ['hypergated', shellPkg]) {
  if (!existsSync(join(OUT, pkg, 'package.json'))) fail(`dist-npm/${pkg} is missing, so run \`npm run build:npm\` first`);
  cpSync(join(OUT, pkg), join(PROJECT, 'node_modules', pkg), { recursive: true });
}
const shim = join(PROJECT, 'node_modules', 'hypergated', 'bin', 'hypergate.mjs');
if (!existsSync(shim)) fail('the packaged CLI shim is missing');
ok(`laid out hypergated@${VERSION} + ${shellPkg} under node_modules/`);

// ── a fake npm, first on PATH, that records instead of installing ────────────
mkdirSync(BIN, { recursive: true });
if (WIN) {
  writeFileSync(join(BIN, 'npm.cmd'), `@echo off\r\n>>"${NPM_LOG}" echo %*\r\nexit /b 0\r\n`);
} else {
  const sh = join(BIN, 'npm');
  writeFileSync(sh, `#!/bin/sh\necho "$@" >> "${NPM_LOG}"\nexit 0\n`, { mode: 0o755 });
}

// ── the stub feed: an npm registry document offering a newer version ─────────
let feedHits = 0;
feed = createServer((req, res) => {
  feedHits += 1;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ name: 'hypergated', 'dist-tags': { latest: NEWER } }));
});
await new Promise((r) => feed.listen(FEED_PORT, '127.0.0.1', r));
ok(`stub update feed serving ${NEWER} on :${FEED_PORT}`);

// A global npm install puts `hypergate` on PATH, which is how the daemon finds
// the shell binary it delegates to. This layout has no PATH entry, so point at
// the binary inside the platform package instead: the same executable, named.
const shellBin = join(PROJECT, 'node_modules', shellPkg, 'bin', WIN ? 'hypergate.exe' : 'hypergate');
if (!existsSync(shellBin)) fail(`the platform shell binary is missing at ${shellBin}`);

const env = {
  ...process.env,
  PATH: `${BIN}${WIN ? ';' : ':'}${process.env.PATH}`,
  HYPERGATE_SHELL_BIN: shellBin,
  HYPERGATE_DIR: DATA,
  HYPERGATE_PORT: String(PORT),
  HYPERGATE_UPDATE_NPM_URL: `http://localhost:${FEED_PORT}/hypergated`,
  // Never let a failed npm feed fall through to the real GitHub API in a test.
  HYPERGATE_UPDATE_GITHUB_URL: `http://localhost:${FEED_PORT}/gh`,
  HYPERGATE_UPDATE_RELAUNCH: '0',
  HYPERGATE_KEYCHAIN_NAMESPACE: `hypergate-smoke-update-${process.pid}`,
};

/** Run the packaged CLI through its own shim, exactly as `hypergate` does. */
const hg = (args, { allowFailure = false } = {}) => {
  try {
    return execFileSync(process.execPath, [shim, ...args], { encoding: 'utf8', env, timeout: 60_000, windowsHide: true }).trim();
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    if (allowFailure) return out;
    fail(`\`hypergate ${args.join(' ')}\` failed: ${out || e.message}`);
    return '';
  }
};

// ── boot the packaged daemon ─────────────────────────────────────────────────
// The package's own daemon entry point (the wrapper that points at the bundled
// UI), i.e. exactly what the `hypergated` command runs.
const daemonEntry = join(PROJECT, 'node_modules', 'hypergated', 'bin', 'hypergated.mjs');
if (!existsSync(daemonEntry)) fail(`packaged daemon entry missing at ${daemonEntry}`);
daemon = spawn(process.execPath, [daemonEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stderr.on('data', (x) => process.stderr.write(x));
let up = false;
for (let i = 0; i < 80 && !up; i++) {
  up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) fail('the packaged daemon did not come up');
ok('packaged daemon up');

const master = (await (await fetch(`${BASE}/api/gateway`)).json()).token;
const getJson = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: res.status < 500 ? await res.json().catch(() => ({})) : {} };
};

// ── awareness ────────────────────────────────────────────────────────────────
const before = await getJson('/api/update');
if (before.body.channel !== 'npm') fail(`expected the npm channel from a node_modules layout, got "${before.body.channel}"`);
if (before.body.canApply !== true) fail('an npm install should be updatable in place');
if (before.body.latest) fail('GET /api/update must not fetch anything by itself');
if (feedHits !== 0) fail(`the daemon reached the feed without being asked (${feedHits} hits)`);
ok('GET /api/update reports the npm channel and never touches the network');

const checked = await getJson('/api/update/check', { method: 'POST' });
if (checked.body.latest !== NEWER) fail(`check did not find ${NEWER}: ${JSON.stringify(checked.body)}`);
if (!checked.body.updateAvailable) fail('a higher version must read as available');
if (checked.body.command !== `npm install -g hypergated@${NEWER}`) fail(`unexpected command: ${checked.body.command}`);
if (feedHits !== 1) fail(`expected exactly one feed request, saw ${feedHits}`);
ok(`check found v${NEWER} and named the command it would run`);

await getJson('/api/update/check', { method: 'POST' });
if (feedHits !== 1) fail(`a second check inside the cache window refetched (${feedHits} hits)`);
await getJson('/api/update/check?force=1', { method: 'POST' });
if (feedHits !== 2) fail(`force did not refetch (${feedHits} hits)`);
ok('the answer is cached for a day, and `force` overrides it');

if (!existsSync(join(DATA, 'update.json'))) fail('the check was not cached to disk');
ok('cached to ~/.hypergate/update.json, so a restart still knows');

const cli = hg(['update']);
if (!cli.includes(NEWER) || !cli.includes('update available')) fail(`\`hypergate update\` said:\n${cli}`);
ok('`hypergate update` reports it too');

// ── guards ───────────────────────────────────────────────────────────────────
const noToken = await fetch(`${BASE}/api/update/apply`, { method: 'POST' });
if (noToken.status !== 401) fail(`apply without a token should 401, got ${noToken.status}`);
const foreign = await fetch(`${BASE}/api/update/apply`, {
  method: 'POST',
  headers: { authorization: `Bearer ${master}`, origin: 'https://evil.example' },
});
if (foreign.status !== 403) fail(`apply from another origin should 403, got ${foreign.status}`);
ok('apply refuses no token and a foreign origin');

// ── the real thing: apply it ─────────────────────────────────────────────────
const exited = new Promise((r) => daemon.once('exit', r));
const applied = await getJson('/api/update/apply', {
  method: 'POST',
  headers: { authorization: `Bearer ${master}`, origin: BASE },
});
if (applied.status !== 200 || applied.body.ok !== true) fail(`apply was not accepted: ${applied.status} ${JSON.stringify(applied.body)}`);
ok(`apply accepted (${applied.body.command})`);

const readLog = () => (existsSync(join(DATA, 'update.log')) ? readFileSync(join(DATA, 'update.log'), 'utf8') : '(no update.log)');
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
if (code === 'timeout') fail(`the daemon was never stopped, so the files could not have been replaced. Log said:
${readLog()}`);
ok(`the daemon was stopped to free its files (exit ${code})`);

// The updater waits for the ports to go quiet, then runs npm. Give it room.
let argv = '';
for (let i = 0; i < 60 && !argv.includes('install'); i++) {
  argv = existsSync(NPM_LOG) ? readFileSync(NPM_LOG, 'utf8') : '';
  if (!argv.includes('install')) await new Promise((r) => setTimeout(r, 500));
}
if (!argv.includes(`install -g hypergated@${NEWER}`)) fail(`npm was not asked to install the new version (log: ${JSON.stringify(argv)})`);
ok(`the updater ran \`npm install -g hypergated@${NEWER}\``);

const log = readLog();
if (!log.includes('update starting')) fail(`the update log is missing its trail:\n${log}`);
if (!log.includes('exited 0')) fail(`the update log does not record the install result:\n${log}`);
if (!log.includes('relaunch skipped')) fail(`the relaunch opt-out was not honoured:\n${log}`);
ok('and left a readable trail in ~/.hypergate/update.log');

cleanup();
console.log('\nUpdate smoke: all green');
process.exit(0);
