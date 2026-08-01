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
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdown, removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const DAEMON = join(ROOT, 'dist-standalone', `hypergated${EXE}`);
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const PORT = 7897;
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'hypergate-standalone-'));

const ok = (m) => console.log(`✓ ${m}`);
let daemon;
const fail = async (m) => {
  console.error(`✗ ${m}`);
  await shutdown(daemon, DIR);
  process.exit(1);
};

if (!existsSync(DAEMON)) {
  console.error(`✗ ${DAEMON} is missing, so run \`npm run build:standalone\` first`);
  removeDir(DIR);
  process.exit(1);
}

// No `node` anywhere in this command: that is the whole point of the artifact.
daemon = spawn(DAEMON, [], {
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
console.log('\nStandalone daemon smoke: all green');
process.exit(0);
