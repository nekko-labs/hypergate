// Smoke test for the v0.4 features: analytics persistence, tool details,
// per-agent (per-server) permissions, and registry search.
// Boots the daemon on a scratch port/data-dir, exercises each, then restarts
// the daemon (same data-dir) to prove analytics survive a restart.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdown, removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7878;
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'hypergate-feat-'));
const ECHO = join(ROOT, 'packages/core/src/fixtures/echo-server.mjs');

const ok = (m) => console.log(`✓ ${m}`);
let daemon;
const fail = (m) => {
  console.error(`✗ ${m}`);
  if (daemon) daemon.kill();
  removeDir(DIR);
  process.exit(1);
};

const boot = async () => {
  const d = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'apps/daemon/src/index.ts')], {
    env: { ...process.env, HYPERGATE_DIR: DIR, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  d.stderr.on('data', (x) => process.stderr.write(x));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) fail('daemon did not come up');
  return d;
};

const gwToken = async () => (await (await fetch(`${BASE}/api/gateway`)).json()).token;

// Hand-rolled MCP-over-fetch with a chosen bearer token.
let rpcId = 0;
const mcp = async (token, method, params, notify = false) => {
  const body = { jsonrpc: '2.0', method, params };
  if (!notify) body.id = ++rpcId;
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (notify) return res;
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};
const session = async (token, name) => {
  await mcp(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '0' } });
  await mcp(token, 'notifications/initialized', undefined, true);
};

daemon = await boot();
ok('daemon up');
const master = await gwToken();

// Add the echo server.
const added = await (await fetch(`${BASE}/api/servers`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'echo', name: 'Echo', runtime: 'process', command: process.execPath, args: [ECHO], enabled: true }),
})).json();
if (added.state !== 'ready') fail(`echo not ready: ${JSON.stringify(added)}`);
ok('echo server added and ready');

// ── tool details ──────────────────────────────────────────────────────────
const servers = await (await fetch(`${BASE}/api/servers`)).json();
const echo = servers.find((s) => s.id === 'echo');
const echoTool = echo?.toolDetails?.find((t) => t.name === 'echo');
if (!echoTool || !echoTool.inputSchema) fail(`echo toolDetails missing schema: ${JSON.stringify(echo?.toolDetails)}`);
ok('server status exposes toolDetails with an input schema');

// ── analytics via the master token ──────────────────────────────────────────
await session(master, 'master-client');
const mc = await mcp(master, 'tools/call', { name: 'echo__echo', arguments: { text: 'nyaa' } });
if (mc.body?.result?.content?.[0]?.text !== 'nyaa') fail(`master call failed: ${JSON.stringify(mc.body)}`);
let analytics = await (await fetch(`${BASE}/api/analytics`)).json();
if (!(analytics.totalCalls >= 1)) fail(`no calls recorded: ${JSON.stringify(analytics.totals)}`);
ok(`analytics recorded a call (totalCalls=${analytics.totalCalls})`);

// ── durable usage history (SQLite store) ────────────────────────────────────
// The itemised feed behind "management of MCP usage". Unlike the old in-memory
// ring this is durable and filterable, so assert both the row and the filters.
const usage = await (await fetch(`${BASE}/api/usage/events?limit=50`)).json();
if (!Array.isArray(usage) || usage.length < 1) fail(`no durable usage events: ${JSON.stringify(usage)}`);
const echoCall = usage.find((e) => e.serverId === 'echo' && e.tool === 'echo');
if (!echoCall) fail(`durable feed missing the echo call: ${JSON.stringify(usage.slice(0, 3))}`);
for (const field of ['at', 'client', 'ms', 'bytesIn', 'bytesOut']) {
  if (echoCall[field] === undefined) fail(`durable usage event missing ${field}`);
}
if (echoCall.ok !== true) fail(`durable usage event should have ok=true: ${JSON.stringify(echoCall)}`);
ok(`durable usage history recorded the call (${usage.length} event(s), client="${echoCall.client}")`);

const filtered = await (await fetch(`${BASE}/api/usage/events?server=echo&limit=50`)).json();
const wrongServer = await (await fetch(`${BASE}/api/usage/events?server=nope&limit=50`)).json();
if (filtered.length < 1) fail('server filter dropped matching events');
if (wrongServer.length !== 0) fail(`server filter matched an unknown server: ${wrongServer.length}`);
ok('durable usage history filters by server');

if (!Array.isArray(analytics.series) || analytics.series.length !== 24) fail('analytics series is not 24 hourly buckets');
if (analytics.series.at(-1).calls < 1) fail('current hour bucket did not count the call');
ok('hourly series bucketed in SQL (current hour has the call)');

// Logs now come from the store, with timestamps, and survive a restart.
const logs = await (await fetch(`${BASE}/api/servers/echo/logs`)).json();
if (!Array.isArray(logs.logs)) fail(`logs endpoint shape changed: ${JSON.stringify(logs).slice(0, 120)}`);
ok(`logs endpoint returned ${logs.logs.length} line(s)${logs.entries ? ' (durable, timestamped)' : ' (in-memory fallback)'}`);

// ── per-agent permissions ───────────────────────────────────────────────────
const blocked = await (await fetch(`${BASE}/api/clients`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'blocked-agent', servers: ['nonexistent'] }),
})).json();
if (!blocked.token) fail('agent creation returned no token');
await session(blocked.token, 'blocked-agent');
const blockedList = await mcp(blocked.token, 'tools/list', {});
if ((blockedList.body?.result?.tools ?? []).some((t) => t.name === 'echo__echo')) fail('scoped-out agent should not see echo');
ok('agent scoped away from echo does not see echo__echo');
const blockedCall = await mcp(blocked.token, 'tools/call', { name: 'echo__echo', arguments: { text: 'x' } });
const blockedErr = blockedCall.body?.error || blockedCall.body?.result?.isError;
if (!blockedErr) fail(`scoped-out agent call should be refused: ${JSON.stringify(blockedCall.body)}`);
ok('agent scoped away from echo is refused on tools/call');

const allowed = await (await fetch(`${BASE}/api/clients`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'echo-agent', servers: ['echo'] }),
})).json();
await session(allowed.token, 'echo-agent');
const allowedList = await mcp(allowed.token, 'tools/list', {});
if (!(allowedList.body?.result?.tools ?? []).some((t) => t.name === 'echo__echo')) fail('echo-scoped agent should see echo');
const allowedCall = await mcp(allowed.token, 'tools/call', { name: 'echo__echo', arguments: { text: 'meow' } });
if (allowedCall.body?.result?.content?.[0]?.text !== 'meow') fail(`echo-scoped agent call failed: ${JSON.stringify(allowedCall.body)}`);
ok('agent scoped to echo can list + call echo__echo');

analytics = await (await fetch(`${BASE}/api/analytics`)).json();
if (!analytics.clients.some((c) => c.client === 'echo-agent')) fail(`analytics did not attribute the call to echo-agent: ${JSON.stringify(analytics.clients.map((c) => c.client))}`);
ok('analytics attributes calls to the named agent');

const rotated = await fetch(`${BASE}/api/clients/${allowed.id}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
});
const rotatedAgent = await rotated.json();
if (rotated.status !== 200 || !rotatedAgent.token || rotatedAgent.token === allowed.token)
  fail(`agent token rotation failed: ${JSON.stringify(rotatedAgent)}`);
if (rotatedAgent.name !== allowed.name || JSON.stringify(rotatedAgent.servers) !== JSON.stringify(allowed.servers))
  fail(`agent token rotation changed scope or name: ${JSON.stringify(rotatedAgent)}`);
allowed.token = rotatedAgent.token;
ok('agent token rotation mints a new credential without changing scope');

// ── enable/disable one server for one agent (the per-agent toggle) ──────────
// The UI's switch is this endpoint, and what it changes must be visible through
// the gateway immediately, which is the whole point of the permission.
const setPerm = async (agentId, serverId, allowedFlag) => {
  const res = await fetch(`${BASE}/api/clients/${agentId}/servers/${encodeURIComponent(serverId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowed: allowedFlag }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};

const off = await setPerm(allowed.id, 'echo', false);
if (off.status !== 200 || (off.body.servers ?? []).includes('echo')) fail(`disabling echo for the agent failed: ${JSON.stringify(off)}`);
const offList = await mcp(allowed.token, 'tools/list', {});
if ((offList.body?.result?.tools ?? []).some((t) => t.name === 'echo__echo')) fail('a server disabled for an agent must vanish from its tools/list');
const offCall = await mcp(allowed.token, 'tools/call', { name: 'echo__echo', arguments: { text: 'x' } });
if (!(offCall.body?.error || offCall.body?.result?.isError)) fail(`a disabled server must refuse tools/call: ${JSON.stringify(offCall.body)}`);
ok('disabling a server for an agent takes effect on the live gateway');

const on = await setPerm(allowed.id, 'echo', true);
if (on.status !== 200 || !(on.body.servers ?? []).includes('echo')) fail(`re-enabling echo failed: ${JSON.stringify(on)}`);
const onCall = await mcp(allowed.token, 'tools/call', { name: 'echo__echo', arguments: { text: 'back' } });
if (onCall.body?.result?.content?.[0]?.text !== 'back') fail(`re-enabled server should answer: ${JSON.stringify(onCall.body)}`);
ok('re-enabling it restores the tool immediately');

// An "all servers" agent has no way to say "all but this one", so turning one
// off must materialise the wildcard into the explicit list it stood for.
const wild = await (await fetch(`${BASE}/api/clients`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'wildcard-agent', servers: '*' }),
})).json();
const pinned = await setPerm(wild.id, 'echo', false);
if (pinned.body.servers === '*' || (pinned.body.servers ?? []).includes('echo'))
  fail(`wildcard agent was not pinned to an explicit list: ${JSON.stringify(pinned.body.servers)}`);
await session(wild.token, 'wildcard-agent');
const wildList = await mcp(wild.token, 'tools/list', {});
if ((wildList.body?.result?.tools ?? []).some((t) => t.name === 'echo__echo')) fail('pinned wildcard agent should not see echo');
ok('disabling a server on an "all servers" agent pins it to the rest');

const bogus = await setPerm(allowed.id, 'no-such-server', true);
if (bogus.status !== 404) fail(`granting access to an unknown server should 404, got ${bogus.status}`);
const revokeBogus = await setPerm(allowed.id, 'no-such-server', false);
if (revokeBogus.status !== 200) fail(`revoking an unknown server should still work, got ${revokeBogus.status}`);
ok('granting an unknown server 404s; revoking one is always allowed');

// ── registry search (network; soft-asserted so it passes offline) ───────────
try {
  const results = await (await fetch(`${BASE}/api/registry/search?q=github`)).json();
  if (!Array.isArray(results)) fail('registry search did not return an array');
  ok(`registry search returned ${results.length} result(s)${results.length ? ` (e.g. ${results[0].name})` : ' — offline or empty'}`);
} catch (e) {
  ok(`registry search endpoint reachable (network result skipped: ${e instanceof Error ? e.message : e})`);
}

// ── trust advice on the catalog ─────────────────────────────────────────────
// Every row the UI can show has to carry a verdict, because the chip and the
// sentence under it are both derived from it: a row with no advice renders as an
// unlabelled result, which is the state this feature exists to remove.
const catalogEntries = await (await fetch(`${BASE}/api/registry`)).json();
const unjudged = catalogEntries.filter((e) => !e.advice?.kind || !e.advice?.message);
if (unjudged.length) fail(`${unjudged.length} curated entr(ies) carry no advice, e.g. ${unjudged[0].id}`);
const playwrightServer = catalogEntries.find((e) => e.id === 'playwright');
if (playwrightServer?.advice?.prefer?.kind !== 'cli')
  fail(`the Playwright server should point at the CLI, got ${JSON.stringify(playwrightServer?.advice?.prefer)}`);
ok(`every curated server carries a verdict (${catalogEntries.length} entries, Playwright names its CLI)`);

// ── the CLI catalog (local; the lookup itself is network and lives above) ────
const cliCatalog = await (await fetch(`${BASE}/api/clis/catalog`)).json();
const playwrightCli = cliCatalog.find((c) => c.id === 'playwright-cli');
if (!playwrightCli) fail('the CLI catalog is missing the official Playwright CLI');
if (playwrightCli.advice?.kind !== 'recommended') fail(`Playwright CLI should be recommended, got ${playwrightCli.advice?.kind}`);
if (!(playwrightCli.installs ?? []).some((i) => i.command.includes('@playwright/cli')))
  fail('the Playwright CLI row has no install command');
if (typeof playwrightCli.installed !== 'boolean') fail('a curated CLI row must answer whether it is installed');
const emptySearch = await (await fetch(`${BASE}/api/clis/search?q=`)).json();
if (!Array.isArray(emptySearch) || emptySearch.length !== 0) fail('an empty CLI query must not search anything');
ok(`CLI catalog serves ${cliCatalog.length} tools with verdicts and install routes; an empty query stays local`);

// ── the one-time OAuth app (read + the guards) ───────────────────────────────
// Deliberately no *successful* POST here: a stored app goes into the real OS
// keychain under `oauth-app:github`, which a smoke run has no business writing to
// on somebody's machine. The write path is exercised by hand against an isolated
// daemon (see the epic in TASKS.md).
const ghApp = await (await fetch(`${BASE}/api/oauth/app/github`)).json();
if (ghApp.configured !== false) fail('a fresh data dir should report no configured GitHub OAuth app');
if (ghApp.redirectUri !== `${BASE}/oauth/callback`) fail(`the setup must offer this daemon's own redirect URI, got ${ghApp.redirectUri}`);
if (!ghApp.requirement?.registerUrl) fail('GitHub must declare where to register an OAuth app');
const unknownProvider = await fetch(`${BASE}/api/oauth/app/not-a-provider`);
if (unknownProvider.status !== 404) fail(`an unknown provider should 404, got ${unknownProvider.status}`);

// Which OAuth app the next sign-in goes to is not something a page the user
// happens to be visiting may decide, so writes carry the shutdown guards.
const appPost = (headers, body = { clientId: 'Ov23liSMOKE', clientSecret: 'smoke' }) =>
  fetch(`${BASE}/api/oauth/app/github`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const appNoToken = await appPost({ origin: BASE });
if (appNoToken.status !== 401) fail(`storing an OAuth app without a token should 401, got ${appNoToken.status}`);
const appForeign = await appPost({ origin: 'https://evil.example', authorization: `Bearer ${master}` });
if (appForeign.status !== 403) fail(`a cross-origin page must not store an OAuth app, got ${appForeign.status}`);
const appDelete = await fetch(`${BASE}/api/oauth/app/github`, { method: 'DELETE', headers: { origin: 'https://evil.example' } });
if (appDelete.status !== 403) fail(`a cross-origin page must not clear an OAuth app, got ${appDelete.status}`);
const noSecret = await appPost({ origin: BASE, authorization: `Bearer ${master}` }, { clientId: 'Ov23liSMOKE' });
if (noSecret.status !== 400) fail(`GitHub requires a client secret; POST without one should 400, got ${noSecret.status}`);
ok('OAuth app setup reports this port’s callback, 404s an unknown provider, demands GitHub’s secret, and refuses no-token / cross-origin writes');

// ── persistence across a restart ────────────────────────────────────────────
const before = analytics.totalCalls;
await new Promise((r) => setTimeout(r, 2300)); // let the debounced writer flush
daemon.kill();
await new Promise((r) => setTimeout(r, 600));
daemon = await boot();
const after = await (await fetch(`${BASE}/api/analytics`)).json();
if (!(after.totalCalls >= before)) fail(`analytics did not persist: before=${before} after=${after.totalCalls}`);
ok(`analytics persisted across restart (totalCalls ${before} → ${after.totalCalls})`);

// The itemised history must survive too — this is the part the old 2000-event
// in-memory ring could never guarantee. (The kill above is a hard terminate on
// Windows, so this also exercises SQLite's WAL recovery.)
const usageAfter = await (await fetch(`${BASE}/api/usage/events?limit=50`)).json();
if (!Array.isArray(usageAfter) || usageAfter.length < 1) fail('durable usage history did not survive the restart');
ok(`durable usage history survived the restart (${usageAfter.length} event(s))`);

// ── a stopped server survives a restart ─────────────────────────────────────
// Stopping a server persists `enabled: false`; it must still be in the roster
// after a boot (it used to vanish from /api/servers and so from the UI), and it
// must still be startable.
await (await fetch(`${BASE}/api/servers/echo/stop`, { method: 'POST' })).json();
await new Promise((r) => setTimeout(r, 300));
daemon.kill();
await new Promise((r) => setTimeout(r, 600));
daemon = await boot();
const roster = await (await fetch(`${BASE}/api/servers`)).json();
const seated = roster.find((s) => s.id === 'echo');
if (!seated) fail(`a stopped server vanished after the restart: ${JSON.stringify(roster.map((s) => s.id))}`);
if (seated.state !== 'stopped') fail(`a stopped server should come back stopped, got ${seated.state}`);
ok('a stopped server is still in the roster after a restart');
const restarted = await (await fetch(`${BASE}/api/servers/echo/start`, { method: 'POST' })).json();
if (restarted.state !== 'ready') fail(`could not start the stopped server again: ${JSON.stringify(restarted)}`);
ok('and can be started again from the UI');

// ── resolving an agent from a key, and the stdio proxy ─────────────────────
// The pair that keeps a connected client working: a key resolves to the agent
// that exists *now* (so a config outlives the id it was written against), and a
// stdio spawn attaches to this daemon instead of starting its own servers.
const resolve_ = (key, create) =>
  fetch(`${BASE}/api/clients/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, create }),
  });

const byName = await (await resolve_('echo-agent')).json();
if (byName.token !== allowed.token) fail(`resolving by name found the wrong agent: ${JSON.stringify(byName.id)}`);
const byStaleId = await (await resolve_(`${allowed.id.replace(/-[0-9a-f]{4}$/, '')}-0000`)).json();
if (byStaleId.token !== allowed.token) fail(`a dead id should resolve to its replacement, got ${JSON.stringify(byStaleId)}`);
const missing = await resolve_('never-connected-anything');
if (missing.status !== 404) fail(`an unknown key should 404, got ${missing.status}`);
const created = await (await resolve_('desktop-probe', true)).json();
if (!created.token || created.created !== true) fail(`create should mint an agent: ${JSON.stringify(created)}`);
if (created.servers !== '*') fail(`a created agent should reach every server, got ${JSON.stringify(created.servers)}`);
const again = await (await resolve_('desktop-probe', true)).json();
if (again.id !== created.id) fail('create should reuse the agent it made, not stack duplicates');
ok('an agent resolves by name, by a dead id, and is created on demand exactly once');

const proxy = spawn(
  process.execPath,
  ['--experimental-strip-types', join(ROOT, 'apps/daemon/src/index.ts'), '--stdio'],
  {
    env: { ...process.env, HYPERGATE_DIR: DIR, PORT: String(PORT), HYPERGATE_STDIO_AGENT: 'desktop-probe' },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let proxyErr = '';
let proxyOut = '';
proxy.stderr.on('data', (x) => (proxyErr += x));
proxy.stdout.on('data', (x) => (proxyOut += x));
const rpc = (msg) => proxy.stdin.write(`${JSON.stringify(msg)}\n`);
rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const proxied = await Promise.race([
  new Promise((r) => {
    const tick = setInterval(() => {
      const line = proxyOut.split('\n').find((l) => l.includes('"id":2'));
      if (line) {
        clearInterval(tick);
        r(JSON.parse(line));
      }
    }, 100);
  }),
  new Promise((r) => setTimeout(() => r('timeout'), 20_000)),
]);
proxy.kill();
if (proxied === 'timeout') fail(`the stdio proxy never answered tools/list: ${proxyErr}`);
if (!/resident daemon/.test(proxyErr)) fail(`--stdio started its own gateway instead of proxying: ${proxyErr}`);
const proxiedTools = proxied.result.tools.map((t) => t.name);
if (!proxiedTools.includes('echo__echo')) fail(`the proxy did not expose the daemon's tools: ${JSON.stringify(proxiedTools)}`);
ok(`--stdio proxied to the running daemon (${proxiedTools.length} tool(s)) instead of starting its own servers`);

// ── stopping the daemon from the API (the UI's Stop button) ─────────────────
// Guards first: the route is the one that ends everything, so an unauthenticated
// caller and a foreign web page must both be turned away before we use it.
const masterAfter = await gwToken();
const noToken = await fetch(`${BASE}/api/shutdown`, { method: 'POST' });
if (noToken.status !== 401) fail(`shutdown without a token should 401, got ${noToken.status}`);
const agentToken = await fetch(`${BASE}/api/shutdown`, {
  method: 'POST',
  headers: { authorization: `Bearer ${allowed.token}` },
});
if (agentToken.status !== 401) fail(`an agent token must not stop the daemon, got ${agentToken.status}`);
const foreign = await fetch(`${BASE}/api/shutdown`, {
  method: 'POST',
  headers: { authorization: `Bearer ${masterAfter}`, origin: 'https://evil.example' },
});
if (foreign.status !== 403) fail(`a cross-origin page must not stop the daemon, got ${foreign.status}`);
ok('shutdown refuses no token, an agent token, and a foreign origin');

const exited = new Promise((r) => daemon.once('exit', r));
const stopRes = await fetch(`${BASE}/api/shutdown`, {
  method: 'POST',
  headers: { authorization: `Bearer ${masterAfter}`, origin: BASE },
});
const stopBody = await stopRes.json();
if (stopRes.status !== 200 || stopBody.ok !== true) fail(`shutdown was not accepted: ${stopRes.status} ${JSON.stringify(stopBody)}`);
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10_000))]);
if (code === 'timeout') fail('the daemon did not exit after accepting the shutdown');
if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) fail('the daemon is still answering after shutdown');
ok(`daemon stopped itself on request (exit ${code}, ${stopBody.servers} managed server(s) taken down)`);

await shutdown(daemon, DIR);
console.log('\nFeature smoke: all green');
process.exit(0);
