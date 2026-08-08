// Smoke test for update awareness, the download, and the one-click update.
//
// Nothing is published to npm yet, so this cannot install a real release. What it
// can do is prove every moving part against a stub feed and a fake `npm`:
//
//   • the daemon knows it was installed with npm (channel detection) from a real
//     node_modules layout, copied out of dist-npm/ rather than pretended at;
//   • a check finds the newer version, resolves the two packages it would pull,
//     caches it for a day, and `force` refetches;
//   • Skip persists, and a forced check spends it;
//   • download-only really downloads: bytes land in ~/.hypergate/updates/<v>/,
//     progress is reported while they do, and a tarball whose hash doesn't match
//     what the feed promised is thrown away rather than installed;
//   • apply is refused without the master token and from another origin;
//   • the accepted one really does stop the daemon, install the **staged**
//     tarballs rather than refetching, record the outcome for the next boot, and
//     log what happened.
//
// The fake npm records its argv instead of installing anything, and the relaunch
// is switched off (HYPERGATE_UPDATE_RELAUNCH=0) so a test never leaves a tray
// icon or an app window behind.
//
//   npm run build:npm && npm run smoke:update
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ── the stub feed: an npm registry serving a newer version, and its tarballs ──
// Real bytes with a real sha512, so the daemon's integrity check is exercised
// rather than skipped. The daemon derives the platform package's URL from the
// main one, which is why both live under the same host.
const tarballs = {
  [`hypergated-${NEWER}.tgz`]: randomBytes(64 * 1024),
  [`${shellPkg}-${NEWER}.tgz`]: randomBytes(96 * 1024),
};
const integrity = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Flip this on to serve a tarball that doesn't match its advertised hash. */
let corrupt = false;
/** Whether the GitHub feed has a release; off while the npm feed is the story. */
let ghHasRelease = false;
/** Whether the npm registry knows the package at all (it doesn't, in the real world yet). */
let npmHasPackage = true;
let packumentHits = 0;
let tarballHits = 0;
const packument = (name) => ({
  name,
  'dist-tags': { latest: NEWER },
  versions: {
    [NEWER]: {
      name,
      version: NEWER,
      dist: {
        tarball: `http://localhost:${FEED_PORT}/tarball/${name}-${NEWER}.tgz`,
        integrity: integrity(tarballs[`${name}-${NEWER}.tgz`]),
      },
    },
  },
});
/**
 * The GitHub "latest release" document, carrying the same two tarballs as
 * attachments. This is the feed that matters in practice right now: with
 * nothing published to npm, the release assets are where an update comes from.
 */
const release = () => ({
  tag_name: `v${NEWER}`,
  html_url: `https://github.com/nekko-labs/hypergate/releases/tag/v${NEWER}`,
  assets: [
    { name: 'Hypergate-Setup.exe', browser_download_url: `http://localhost:${FEED_PORT}/tarball/nope`, size: 10 },
    { name: 'SHA256SUMS', browser_download_url: `http://localhost:${FEED_PORT}/SHA256SUMS`, size: 0 },
    ...Object.entries(tarballs).map(([name, body]) => ({
      name,
      browser_download_url: `http://localhost:${FEED_PORT}/tarball/${name}`,
      size: body.length,
    })),
  ],
});
feed = createServer((req, res) => {
  const path = req.url ?? '/';
  if (path.startsWith('/gh')) {
    packumentHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ghHasRelease ? release() : { message: 'Not Found' }));
    return;
  }
  if (path.startsWith('/tarball/')) {
    const name = decodeURIComponent(path.slice('/tarball/'.length));
    const body = tarballs[name];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    // A HEAD is how the daemon learns the size of an npm tarball (a packument
    // doesn't say), so it is answered but not counted as a download.
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) }).end();
      return;
    }
    tarballHits += 1;
    // A byte flipped in transit must not survive the integrity check.
    const served = corrupt ? Buffer.concat([body.subarray(0, body.length - 1), Buffer.from([body[body.length - 1] ^ 0xff])]) : body;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(served.length) });
    res.end(served);
    return;
  }
  if (path === '/SHA256SUMS') {
    const text = Object.entries(tarballs)
      .map(([name, body]) => `${sha256(body)}  ${name}`)
      .join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(text);
    return;
  }
  packumentHits += 1;
  const name = path.replace(/^\//, '').split('?')[0];
  const known = npmHasPackage && (name === 'hypergated' || name === shellPkg);
  res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(known ? packument(name) : { error: 'Not found' }));
});
await new Promise((r) => feed.listen(FEED_PORT, '127.0.0.1', r));
ok(`stub registry serving ${NEWER} + its tarballs on :${FEED_PORT}`);

// The daemon has to find the shell binary **by itself**, from the node_modules
// layout, with nothing pointing at it.
//
// This used to set HYPERGATE_SHELL_BIN, and that convenience hid a real bug for
// three releases: a global npm install puts `hypergate.cmd`/`.ps1` on PATH and
// the actual executable inside the platform package, so the daemon's PATH scan
// found nothing and one-click updates failed on the only channel they are
// offered on. The override is exactly what a user never has, so the test must
// not have it either.
const shellBin = join(PROJECT, 'node_modules', shellPkg, 'bin', WIN ? 'hypergate.exe' : 'hypergate');
if (!existsSync(shellBin)) fail(`the platform shell binary is missing at ${shellBin}`);

const env = {
  ...process.env,
  // Deliberately no HYPERGATE_SHELL_BIN: see above. PATH carries only the fake
  // npm, and `hypergate.exe` is not on it, exactly as on a real install.
  PATH: `${BIN}${WIN ? ';' : ':'}${process.env.PATH}`,
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

// ── booting the packaged daemon ──────────────────────────────────────────────
// The package's own daemon entry point (the wrapper that points at the bundled
// UI), i.e. exactly what the `hypergated` command runs.
const daemonEntry = join(PROJECT, 'node_modules', 'hypergated', 'bin', 'hypergated.mjs');
if (!existsSync(daemonEntry)) fail(`packaged daemon entry missing at ${daemonEntry}`);

const boot = async (port, dataDir) => {
  // Somebody else's daemon on our port would be tested instead of ours, and
  // every assertion after that would be about the wrong process.
  if (await fetch(`http://localhost:${port}/health`).then((r) => r.ok).catch(() => false)) {
    fail(`something is already listening on :${port}; stop it before running this smoke`);
  }
  const child = spawn(process.execPath, [daemonEntry], {
    env: { ...env, HYPERGATE_PORT: String(port), HYPERGATE_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (x) => process.stderr.write(x));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return child;
    await sleep(200);
  }
  fail(`the packaged daemon did not come up on :${port}`);
  return child;
};

// ── phase 1: the GitHub release feed ─────────────────────────────────────────
// The path that matters today. `hypergated` is not on npm, so the update has to
// come off the release's attached tarballs or it cannot happen at all.
{
  npmHasPackage = false;
  ghHasRelease = true;
  const port = PORT + 11;
  const dataDir = join(PROJECT, 'gh-data');
  const gh = await boot(port, dataDir);
  const ghBase = `http://localhost:${port}`;
  const ghToken = (await (await fetch(`${ghBase}/api/gateway`)).json()).token;
  const ghAuth = { authorization: `Bearer ${ghToken}`, origin: ghBase };

  const found = await (await fetch(`${ghBase}/api/update/check`, { method: 'POST' })).json();
  if (found.latest !== NEWER) fail(`the GitHub feed was not consulted when npm 404s: ${JSON.stringify(found)}`);
  if (found.source !== 'github') fail(`expected the github source, got "${found.source}"`);
  if (!found.canDownload) fail('the release attaches both tarballs, so it must be downloadable');
  const expected = Object.values(tarballs).reduce((n, b) => n + b.length, 0);
  if (found.downloadSize !== expected) fail(`the release sizes should give an exact download size, got ${found.downloadSize}`);
  ok('with nothing on npm, the GitHub release answers, and its assets are what would be downloaded');

  tarballHits = 0;
  await fetch(`${ghBase}/api/update/download`, { method: 'POST', headers: ghAuth });
  let p = { stage: 'downloading' };
  for (let i = 0; i < 120 && p.stage !== 'staged'; i++) {
    p = await (await fetch(`${ghBase}/api/update/progress`)).json();
    if (p.stage === 'error') fail(`downloading from the release failed: ${p.error}`);
    if (p.stage !== 'staged') await sleep(100);
  }
  if (p.stage !== 'staged') fail(`the release download never finished: ${JSON.stringify(p)}`);
  if (tarballHits !== 2) fail(`expected both release assets to be fetched, saw ${tarballHits}`);
  if (!existsSync(join(dataDir, 'updates', NEWER, `hypergated-${NEWER}.tgz`))) fail('the release tarball did not land');
  ok('and they download from the release exactly as an npm tarball would');

  gh.kill();
  npmHasPackage = true;
  ghHasRelease = false;
  packumentHits = 0;
  tarballHits = 0;
}

// ── phase 2: the npm registry feed, all the way through an install ───────────
daemon = await boot(PORT, DATA);
ok('packaged daemon up');

const master = (await (await fetch(`${BASE}/api/gateway`)).json()).token;
const getJson = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: res.status < 500 ? await res.json().catch(() => ({})) : {} };
};
const auth = { authorization: `Bearer ${master}`, origin: BASE };

// ── awareness ────────────────────────────────────────────────────────────────
// The regression guard for the bug this smoke used to hide: the daemon must
// locate the shell binary from a plain node_modules layout, with nothing
// pointing at it. `startupVia` is the cheapest honest witness — it reads
// `shell.hasShell()` directly, and asking here costs no state, whereas the
// other route to the same answer is an apply that would really update.
const settings = await getJson('/api/settings');
if (settings.body.startupVia !== 'shell') {
  fail(
    `the daemon did not find the shell binary in a node_modules layout (startupVia=${settings.body.startupVia}), ` +
      'so one-click updates would fail on a real npm install',
  );
}
ok('the daemon finds the shell binary by itself, with nothing pointing at it');

const before = await getJson('/api/update');
if (before.body.channel !== 'npm') fail(`expected the npm channel from a node_modules layout, got "${before.body.channel}"`);
if (before.body.canApply !== true) fail('an npm install should be updatable in place');
if (before.body.latest) fail('GET /api/update must not fetch anything by itself');
if (packumentHits !== 0) fail(`the daemon reached the feed without being asked (${packumentHits} hits)`);
ok('GET /api/update reports the npm channel and never touches the network');

const checked = await getJson('/api/update/check', { method: 'POST' });
if (checked.body.latest !== NEWER) fail(`check did not find ${NEWER}: ${JSON.stringify(checked.body)}`);
if (!checked.body.updateAvailable) fail('a higher version must read as available');
if (checked.body.command !== `npm install -g hypergated@${NEWER}`) fail(`unexpected command: ${checked.body.command}`);
if (!checked.body.canDownload) fail('the feed named both tarballs, so the update must be downloadable');
ok(`check found v${NEWER}, named the command, and resolved what it would download`);

const cachedHits = packumentHits;
await getJson('/api/update/check', { method: 'POST' });
if (packumentHits !== cachedHits) fail(`a second check inside the cache window refetched (${packumentHits} hits)`);
await getJson('/api/update/check?force=1', { method: 'POST' });
if (packumentHits === cachedHits) fail('force did not refetch');
ok('the answer is cached for a day, and `force` overrides it');

if (!existsSync(join(DATA, 'update.json'))) fail('the check was not cached to disk');
ok('cached to ~/.hypergate/update.json, so a restart still knows');

const cli = hg(['update']);
if (!cli.includes(NEWER) || !cli.includes('update available')) fail(`\`hypergate update\` said:\n${cli}`);
ok('`hypergate update` reports it too');

// ── skip, and un-skip ────────────────────────────────────────────────────────
await getJson('/api/settings', {
  method: 'PATCH',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ skippedUpdate: NEWER }),
});
const skipped = await getJson('/api/update');
if (skipped.body.skipped !== NEWER) fail(`skip was not recorded: ${JSON.stringify(skipped.body)}`);
if (!skipped.body.updateAvailable) fail('skipping must not make the update disappear from the truth, only from the offer');
const respun = await getJson('/api/update/check?force=1', { method: 'POST' });
if (respun.body.skipped) fail('a forced check should spend the skip');
ok('Skip is remembered across requests, and pressing check again spends it');

// ── the download is refused when the bytes do not match the promise ──────────
corrupt = true;
const bad = await getJson('/api/update/download', { method: 'POST', headers: auth });
if (bad.status !== 202) fail(`download should be accepted then fail on the hash, got ${bad.status}`);
let progress = { stage: 'downloading' };
for (let i = 0; i < 60 && progress.stage === 'downloading'; i++) {
  await sleep(200);
  progress = (await getJson('/api/update/progress')).body;
}
if (progress.stage !== 'error') fail(`a corrupted tarball must fail the download, got ${JSON.stringify(progress)}`);
if (!/integrity|checksum/i.test(progress.error ?? '')) fail(`the error should name the integrity check: ${progress.error}`);
if (existsSync(join(DATA, 'updates', NEWER))) fail('a failed download must leave nothing staged');
ok('a tarball whose hash does not match what the feed promised is thrown away');

// ── download only ────────────────────────────────────────────────────────────
corrupt = false;
tarballHits = 0;
const started = await getJson('/api/update/download', { method: 'POST', headers: auth });
if (started.status !== 202 || started.body.ok !== true) fail(`download was not accepted: ${started.status}`);
let sawDownloading = false;
progress = { stage: 'downloading' };
for (let i = 0; i < 120 && progress.stage !== 'staged'; i++) {
  progress = (await getJson('/api/update/progress')).body;
  if (progress.stage === 'downloading') sawDownloading = true;
  if (progress.stage === 'error') fail(`the download failed: ${progress.error}`);
  if (progress.stage !== 'staged') await sleep(100);
}
if (progress.stage !== 'staged') fail(`the download never finished: ${JSON.stringify(progress)}`);
if (!sawDownloading) fail('the job finished without ever reporting itself as running');
if (tarballHits !== 2) fail(`expected both packages to be fetched, saw ${tarballHits}`);
// An npm packument declares no tarball size, so the total has to come from the
// wire or the bar can never fill.
if (progress.total !== Object.values(tarballs).reduce((n, b) => n + b.length, 0)) {
  fail(`the download total was not resolved from the wire: ${JSON.stringify(progress)}`);
}
const stagedDir = join(DATA, 'updates', NEWER);
const files = readdirSync(stagedDir).sort();
if (!files.includes(`hypergated-${NEWER}.tgz`) || !files.includes(`${shellPkg}-${NEWER}.tgz`) || !files.includes('manifest.json')) {
  fail(`the staging directory is not what it should be: ${files.join(', ')}`);
}
for (const [name, body] of Object.entries(tarballs)) {
  const onDisk = readFileSync(join(stagedDir, name));
  if (!onDisk.equals(body)) fail(`${name} did not land byte-for-byte`);
}
if (files.some((f) => f.endsWith('.part'))) fail('a finished download left a .part file behind');
ok(`downloaded both packages to ~/.hypergate/updates/${NEWER}/, byte-for-byte, and said so while it ran`);

const staged = await getJson('/api/update');
if (staged.body.staged !== NEWER) fail(`the daemon does not report the staged version: ${JSON.stringify(staged.body)}`);
ok('and reports it as ready to install');

// A second download must not refetch what is already there.
tarballHits = 0;
await getJson('/api/update/download', { method: 'POST', headers: auth });
await sleep(300);
if (tarballHits !== 0) fail(`an already-staged version was downloaded again (${tarballHits} hits)`);
ok('asking again does not download it twice');

// ── guards ───────────────────────────────────────────────────────────────────
const noToken = await fetch(`${BASE}/api/update/apply`, { method: 'POST' });
if (noToken.status !== 401) fail(`apply without a token should 401, got ${noToken.status}`);
const foreign = await fetch(`${BASE}/api/update/apply`, {
  method: 'POST',
  headers: { authorization: `Bearer ${master}`, origin: 'https://evil.example' },
});
if (foreign.status !== 403) fail(`apply from another origin should 403, got ${foreign.status}`);
const noTokenDl = await fetch(`${BASE}/api/update/download`, { method: 'POST' });
if (noTokenDl.status !== 401) fail(`download without a token should 401, got ${noTokenDl.status}`);
ok('apply and download both refuse no token and a foreign origin');

// ── the real thing: apply it ─────────────────────────────────────────────────
tarballHits = 0;
const exited = new Promise((r) => daemon.once('exit', r));
const applied = await getJson('/api/update/apply', { method: 'POST', headers: auth });
if (applied.status !== 202 || applied.body.ok !== true) fail(`apply was not accepted: ${applied.status} ${JSON.stringify(applied.body)}`);
ok(`apply accepted (${applied.body.command})`);

const readLog = () => (existsSync(join(DATA, 'update.log')) ? readFileSync(join(DATA, 'update.log'), 'utf8') : '(no update.log)');
const code = await Promise.race([exited, sleep(30_000).then(() => 'timeout')]);
if (code === 'timeout') fail(`the daemon was never stopped, so the files could not have been replaced. Log said:
${readLog()}`);
ok(`the daemon was stopped to free its files (exit ${code})`);

// The updater waits for the ports to go quiet, then runs npm. Give it room.
let argv = '';
for (let i = 0; i < 60 && !argv.includes('install'); i++) {
  argv = existsSync(NPM_LOG) ? readFileSync(NPM_LOG, 'utf8') : '';
  if (!argv.includes('install')) await sleep(500);
}
if (!argv.includes('install -g')) fail(`npm was not asked to install anything (log: ${JSON.stringify(argv)})`);
if (!argv.includes(`hypergated-${NEWER}.tgz`) || !argv.includes(`${shellPkg}-${NEWER}.tgz`)) {
  fail(`the updater did not install the staged tarballs (npm argv: ${JSON.stringify(argv)})`);
}
if (tarballHits !== 0) fail('the install refetched what had already been downloaded');
ok('the updater installed the staged tarballs, with no second download');

const log = readLog();
if (!log.includes('update starting')) fail(`the update log is missing its trail:\n${log}`);
if (!log.includes('exited 0')) fail(`the update log does not record the install result:\n${log}`);
if (!log.includes('relaunch skipped')) fail(`the relaunch opt-out was not honoured:\n${log}`);
ok('and left a readable trail in ~/.hypergate/update.log');

const resultPath = join(DATA, 'updates', 'last-result.json');
for (let i = 0; i < 40 && !existsSync(resultPath); i++) await sleep(250);
if (!existsSync(resultPath)) fail('the updater did not record its outcome for the next boot');
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
if (result.ok !== true || result.version !== NEWER) fail(`unexpected update result: ${JSON.stringify(result)}`);
if (existsSync(stagedDir)) fail('the staged tarballs should be cleaned up once installed');
ok(`recorded "updated to v${NEWER}" for the version that comes up next, and cleaned up after itself`);

cleanup();
console.log('\nUpdate smoke: all green');
process.exit(0);
