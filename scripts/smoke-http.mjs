// Smoke test: the streamable-HTTP MCP gateway end-to-end.
// Boots the daemon on a scratch port/data-dir, adds the in-repo echo server,
// then speaks MCP over plain fetch: initialize → tools/list → tools/call.
// Also asserts the bearer token is enforced (401 without it).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdown, removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7877;
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'hypergate-smoke-'));

const daemon = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'apps/daemon/src/index.ts')], {
  env: { ...process.env, HYPERGATE_DIR: DIR, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
daemon.stderr.on('data', (d) => process.stderr.write(d));

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  daemon.kill();
  removeDir(DIR);
  process.exit(1);
};
const ok = (msg) => console.log(`✓ ${msg}`);

// Wait for the daemon.
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) fail('daemon did not come up');
ok('daemon up');

const gw = await (await fetch(`${BASE}/api/gateway`)).json();
if (!gw.token || !gw.url.endsWith('/mcp')) fail(`bad gateway info: ${JSON.stringify(gw)}`);
ok(`gateway info has token + url (${gw.url})`);

// Add the echo server through the management API.
const add = await fetch(`${BASE}/api/servers`, {
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
});
const added = await add.json();
if (added.state !== 'ready') fail(`echo server not ready: ${JSON.stringify(added)}`);
ok('echo server added and ready');

// MCP over streamable HTTP, hand-rolled (mirrors what Open Paw's client does).
let rpcId = 0;
const mcp = async (method, params, { auth = true, notify = false } = {}) => {
  const body = { jsonrpc: '2.0', method, params };
  if (!notify) body.id = ++rpcId;
  const res = await fetch(gw.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: `Bearer ${gw.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (notify) return res;
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};

// 401 without the token.
const noAuth = await mcp('initialize', {}, { auth: false });
if (noAuth.status !== 401) fail(`expected 401 without token, got ${noAuth.status}`);
ok('401 without bearer token');

const init = await mcp('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
if (init.status !== 200 || !init.body?.result?.serverInfo?.name) fail(`initialize failed: ${JSON.stringify(init)}`);
ok(`initialize ok (${init.body.result.serverInfo.name})`);

await mcp('notifications/initialized', undefined, { notify: true });

const list = await mcp('tools/list', {});
const tools = list.body?.result?.tools ?? [];
if (!tools.some((t) => t.name === 'echo__echo')) fail(`echo__echo not in tools: ${JSON.stringify(tools.map((t) => t.name))}`);
ok(`tools/list has echo__echo (${tools.length} tool(s))`);

const call = await mcp('tools/call', { name: 'echo__echo', arguments: { text: 'nyaa' } });
const text = call.body?.result?.content?.[0]?.text;
if (text !== 'nyaa') fail(`tools/call wrong result: ${JSON.stringify(call.body)}`);
ok('tools/call routed to the echo server and returned "nyaa"');

await shutdown(daemon, DIR);
console.log('\nHTTP gateway smoke: all green');
process.exit(0);
