// Smoke test: what a user actually installs.
//
// Packs the npm packages from dist-npm/, installs the tarballs into a throwaway
// project the way `npm install -g hypergated` would, and then drives the
// *installed* CLI: start the daemon, add a server, list its tools through the
// gateway, call one, remove it, stop. Nothing here touches the repo's own build
// output at runtime. If this passes, the published package works.
//
//   npm run build:npm && npm run smoke:install
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-npm');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const PORT = 7893;
const PROJECT = mkdtempSync(join(tmpdir(), 'hypergate-install-'));
const DATA = join(PROJECT, 'data');
// The keychain is machine-global, so scope this run's entries and delete them
// on the way out rather than leaving test tokens in the user's credential store.
const NAMESPACE = `hypergate-smoke-install-${process.pid}`;

const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  console.error(`✗ ${m}`);
  cleanup();
  process.exit(1);
};

const shellPkg = `hypergate-shell-${process.platform}-${process.arch}`;
const env = {
  ...process.env,
  HYPERGATE_DIR: DATA,
  HYPERGATE_PORT: String(PORT),
  HYPERGATE_KEYCHAIN_NAMESPACE: NAMESPACE,
};

/** Run the installed CLI through its own JS shim, exactly as the `hypergate`
 *  command does, with no repo paths involved. */
const hg = (args, { allowFailure = false } = {}) => {
  try {
    return execFileSync(process.execPath, [join(PROJECT, 'node_modules', 'hypergated', 'bin', 'hypergate.mjs'), ...args], {
      encoding: 'utf8',
      env,
      timeout: 180_000,
      windowsHide: true,
    }).trim();
  } catch (e) {
    if (allowFailure) return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    fail(`\`hypergate ${args.join(' ')}\` failed (exit ${e.status}, ${e.message}): ${e.stderr || e.stdout}`);
    return '';
  }
};

function cleanup() {
  try {
    hg(['stop'], { allowFailure: true });
    hg(['secret', 'delete', 'gateway-token'], { allowFailure: true });
  } catch {
    /* nothing to stop */
  }
  removeDir(PROJECT);
}

const npmCli = () =>
  [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(existsSync);

const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ── pack + install ───────────────────────────────────────────────────────────

for (const dir of ['hypergated', shellPkg]) {
  if (!existsSync(join(OUT, dir, 'package.json'))) fail(`dist-npm/${dir} is missing, so run \`npm run build:npm\` first`);
  npm(['pack', '--pack-destination', OUT], join(OUT, dir));
}
const tarball = (name) => {
  const hit = readdirSync(OUT).find((f) => f === `${name}-${VERSION}.tgz`);
  if (!hit) fail(`no tarball for ${name}@${VERSION} in dist-npm/`);
  return join(OUT, hit).replaceAll('\\', '/');
};
ok(`packed hypergated@${VERSION} and ${shellPkg}@${VERSION}`);

writeFileSync(
  join(PROJECT, 'package.json'),
  JSON.stringify(
    {
      name: 'hypergate-install-smoke',
      private: true,
      version: '1.0.0',
      dependencies: { hypergated: `file:${tarball('hypergated')}` },
      // The platform package isn't on the registry yet, so point the optional
      // dependency at the tarball we just built. Everything else resolves the
      // way it will for a real user.
      overrides: { [shellPkg]: `file:${tarball(shellPkg)}` },
    },
    null,
    2,
  ),
);
npm(['install', '--no-audit', '--no-fund'], PROJECT);
if (!existsSync(join(PROJECT, 'node_modules', 'hypergated', 'bin', 'hypergate.mjs'))) fail('hypergated did not install');
if (!existsSync(join(PROJECT, 'node_modules', shellPkg, 'bin'))) fail(`${shellPkg} did not install`);
ok('installed from the tarballs into a clean project');

// ── drive the installed CLI ──────────────────────────────────────────────────

const version = hg(['--version']);
if (!version.includes(VERSION)) fail(`--version said "${version}", expected ${VERSION}`);
ok(`hypergate --version → ${version}`);

const down = hg(['status']);
if (!down.includes('not running')) fail(`status before start said: ${down}`);
ok('status reports honestly with no daemon running');

// --no-open --no-shortcut: `start` is the one-command setup, and a smoke test
// must not open a browser tab or leave a Start Menu entry on the machine that
// runs it. The headless guard would catch this on CI; it would not run locally.
const started = hg(['start', '--no-open', '--no-shortcut']);
if (!started.includes(String(PORT))) fail(`start said: ${started}`);
ok(`daemon started by the installed CLI (${started.split('\n')[0]})`);

const status = hg(['status']);
if (!status.includes('running')) fail(`status said: ${status}`);
ok('status sees the daemon');

// The UI ships in the package too, and a user who runs `hypergate open` must get
// the manager, not a placeholder page.
const html = await fetch(`http://localhost:${PORT}/`).then((r) => r.text());
if (!html.includes('<div id="root">')) fail(`the packaged daemon did not serve the web UI: ${html.slice(0, 200)}`);
ok('the packaged web UI is served');

const catalog = hg(['catalog']);
if (!catalog.includes('nekkos')) fail(`catalog looked wrong: ${catalog.slice(0, 200)}`);
ok('catalog lists the curated servers');

// A real stdio MCP server, launched by the installed daemon.
const echo = join(ROOT, 'packages/core/src/fixtures/echo-server.mjs');
const added = hg(['add', 'echo', '--name', 'Echo', '--command', process.execPath, '--arg', echo]);
if (!added.includes('ready')) fail(`add did not reach ready: ${added}`);
ok(`add → ${added}`);

const list = hg(['list']);
if (!/echo\s+Echo\s+ready/.test(list)) fail(`list looked wrong:\n${list}`);
ok('list shows it ready');

const tools = hg(['tools', '--server', 'echo']);
if (!tools.includes('echo__echo')) fail(`tools/list through the gateway missed echo__echo:\n${tools}`);
ok('the gateway aggregates its tools');

const called = hg(['call', 'echo__echo', '{"text":"nyaa"}']);
if (called !== 'nyaa') fail(`tools/call returned "${called}"`);
ok('call routed through the gateway and returned "nyaa"');

// A tool that fails must exit non-zero, or scripts can't tell.
const badTool = hg(['call', 'echo__does-not-exist', '{}'], { allowFailure: true });
if (!badTool.toLowerCase().includes('error') && !badTool.toLowerCase().includes('unknown')) {
  fail(`a bad tool call should have reported an error, said: ${badTool}`);
}
ok('a failing tool call reports the error');

hg(['server', 'stop', 'echo']);
if (!/echo\s+Echo\s+stopped/.test(hg(['list']))) fail('server stop did not take effect');
hg(['server', 'start', 'echo']);
if (!/echo\s+Echo\s+ready/.test(hg(['list']))) fail('server start did not take effect');
ok('server stop/start drive the supervisor');

const gateway = hg(['gateway']);
if (!gateway.includes(`http://localhost:${PORT}/mcp`)) fail(`gateway said: ${gateway}`);
ok('gateway prints the endpoint to paste into a harness');

hg(['rm', 'echo']);
if (hg(['list']).includes('echo')) fail('rm left the server behind');
ok('rm removes it');

const stopped = hg(['stop']);
if (!stopped.toLowerCase().includes('stopped')) fail(`stop said: ${stopped}`);
ok('stop shuts the daemon down');

cleanup();
console.log('\nPackaged install smoke: all green');
process.exit(0);
