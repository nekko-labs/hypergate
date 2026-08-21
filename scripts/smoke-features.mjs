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
    // HYPERGATE_NO_KEYCHAIN: a smoke daemon has no business writing scratch
    // secrets into the developer's real OS keychain; the file fallback keeps
    // everything inside the temp data dir it is about to delete.
    env: { ...process.env, HYPERGATE_DIR: DIR, PORT: String(PORT), HYPERGATE_NO_KEYCHAIN: '1' },
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

// ── the credential vault ─────────────────────────────────────────────────────
// Store → gate → hand out → roll → delete, end to end. Values must reach
// exactly three places (a spawned server's env, an allowed agent's
// credential_env call, /api/credentials/resolve) and no API response else.
const credHeaders = { 'content-type': 'application/json', authorization: `Bearer ${master}` };

const credNoToken = await fetch(`${BASE}/api/credentials`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', value: 'y' }),
});
if (credNoToken.status !== 401) fail(`creating a credential without the master token should 401, got ${credNoToken.status}`);
const credForeign = await fetch(`${BASE}/api/credentials`, {
  method: 'POST', headers: { ...credHeaders, origin: 'https://evil.example' }, body: JSON.stringify({ name: 'X', value: 'y' }),
});
if (credForeign.status !== 403) fail(`a cross-origin page must not create a credential, got ${credForeign.status}`);
ok('credential writes refuse no-token and cross-origin callers');

const SECRET_VALUE = 'smoke_fly_v1_0123456789abcdef';
const cred = await (await fetch(`${BASE}/api/credentials`, {
  method: 'POST', headers: credHeaders,
  body: JSON.stringify({ name: 'Smoke token', value: SECRET_VALUE, envVar: 'SMOKE_TOKEN' }),
})).json();
if (!cred.id || cred.envVar !== 'SMOKE_TOKEN') fail(`credential create failed: ${JSON.stringify(cred)}`);
const credList = await (await fetch(`${BASE}/api/credentials`)).json();
if (JSON.stringify(credList).includes(SECRET_VALUE)) fail('the credentials list leaked a value');
if (!credList.find((c) => c.id === cred.id)?.hint) fail('the credentials list carries no masked hint');
ok(`credential stored (${cred.id}), list is masked and valueless`);

// The guides: static, joined with what is stored, never a fetch.
const guides = await (await fetch(`${BASE}/api/credentials/guides`)).json();
if (!Array.isArray(guides) || !guides.find((g) => g.service === 'fly')?.createUrl) fail('credential guides missing the fly guide');
ok(`credential guides served (${guides.length} services)`);

// Spawn injection: a server whose config references the credential sees the
// value in its env; nothing was written into servers.json.
const ENVPROBE = join(ROOT, 'packages/core/src/fixtures/env-server.mjs');
const probeAdd = await (await fetch(`${BASE}/api/servers`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'envprobe', name: 'Env probe', runtime: 'process', command: process.execPath, args: [ENVPROBE],
    credentialRefs: { SMOKE_TOKEN: cred.id }, enabled: true,
  }),
})).json();
if (probeAdd.state !== 'ready') fail(`envprobe not ready: ${JSON.stringify(probeAdd)}`);
const probeEnv = await mcp(master, 'tools/call', { name: 'envprobe__env', arguments: { name: 'SMOKE_TOKEN' } });
if (probeEnv.body?.result?.content?.[0]?.text !== SECRET_VALUE) fail(`credentialRefs did not reach the child env: ${JSON.stringify(probeEnv.body)}`);
const { readFileSync } = await import('node:fs');
if (readFileSync(join(DIR, 'servers.json'), 'utf8').includes(SECRET_VALUE)) fail('servers.json contains the secret value');
ok('a credentialRefs entry reaches the spawned server env; servers.json holds only the reference');

const reserved = await fetch(`${BASE}/api/servers`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'hypergate', name: 'Shadow', runtime: 'process', command: 'x', enabled: false }),
});
if (reserved.status !== 400) fail(`the reserved id "hypergate" should be refused, got ${reserved.status}`);
const badRef = await fetch(`${BASE}/api/servers`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'badref', name: 'Bad', runtime: 'process', command: 'x', credentialRefs: { SMOKE_TOKEN: 'no-such-cred' } }),
});
if (badRef.status !== 400) fail(`an unknown credential ref should be refused, got ${badRef.status}`);
ok('the hypergate id is reserved and a dangling credentialRef is refused at add time');

// Gating on the gateway: deny-by-default, then a one-flip grant.
//
// Since v1.9.0 an ungranted agent *sees* the credential (name and env var, so
// it can ask for it) but still cannot fetch it. The row must carry allowed:false
// and a request URL, and must not carry the hint, which is still four characters
// of a secret this caller was not granted.
const deniedList = await mcp(allowed.token, 'tools/call', { name: 'hypergate__credentials_list', arguments: {} });
const deniedRows = JSON.parse(deniedList.body?.result?.content?.[0]?.text ?? '[]');
const deniedRow = deniedRows.find((r) => r.id === cred.id);
if (!deniedRow) fail(`an ungranted agent should still see the credential name: ${JSON.stringify(deniedRows)}`);
if (deniedRow.allowed !== false) fail(`the row must say allowed:false, got ${JSON.stringify(deniedRow)}`);
if (!deniedRow.requestUrl?.includes(cred.id)) fail(`the row must carry a request URL: ${JSON.stringify(deniedRow)}`);
if (deniedRow.hint) fail('an ungranted row must not carry the masked hint');
if (JSON.stringify(deniedRows).includes(SECRET_VALUE)) fail('credentials_list leaked a value');
const deniedEnv = await mcp(allowed.token, 'tools/call', { name: 'hypergate__credential_env', arguments: { id: cred.id } });
if (!(deniedEnv.body?.error || deniedEnv.body?.result?.isError)) fail(`an ungranted agent must be refused credential_env: ${JSON.stringify(deniedEnv.body)}`);
if (JSON.stringify(deniedEnv.body).includes(SECRET_VALUE)) fail('a refusal leaked the value');
ok('credentials are deny-by-default on the gateway (named but unfetchable, refused fetch)');

// The refusal above must have filed a request, so the user has something to act
// on rather than a dead end.
const filedAfterRefusal = await (await fetch(`${BASE}/api/credential-requests`)).json();
const refusalReq = filedAfterRefusal.requests?.find((r) => r.credentialId === cred.id && r.agentId === allowed.id);
if (!refusalReq) fail(`a refused credential_env should file a request: ${JSON.stringify(filedAfterRefusal)}`);
if (JSON.stringify(filedAfterRefusal).includes(SECRET_VALUE)) fail('the request list leaked a value');
ok(`a refused fetch files an access request (${refusalReq.id})`);

// credential_request: explicit, carries a reason, and deduped onto the row the
// refusal already created rather than piling up.
const askedAgain = await mcp(allowed.token, 'tools/call', {
  name: 'hypergate__credential_request',
  arguments: { id: cred.id, reason: 'smoke test needs the token' },
});
const askedPayload = JSON.parse(askedAgain.body?.result?.content?.[0]?.text ?? '{}');
if (!askedPayload.filed || !askedPayload.url?.includes(cred.id)) fail(`credential_request should file and return a URL: ${JSON.stringify(askedAgain.body)}`);
const afterAsk = await (await fetch(`${BASE}/api/credential-requests`)).json();
const deduped = afterAsk.requests.filter((r) => r.credentialId === cred.id && r.agentId === allowed.id);
if (deduped.length !== 1) fail(`asking twice must dedupe to one request, got ${deduped.length}`);
if (deduped[0].attempts < 2) fail(`the deduped request should count attempts, got ${deduped[0].attempts}`);
if (deduped[0].reason !== 'smoke test needs the token') fail(`the later reason should stick: ${JSON.stringify(deduped[0])}`);
ok('credential_request files once, counts attempts, and keeps the supplied reason');

// Answering a request is a grant, so it needs the master token + same origin.
const answerNoToken = await fetch(`${BASE}/api/credential-requests/${deduped[0].id}/approve`, { method: 'POST' });
if (answerNoToken.status !== 401) fail(`approving without the master token should 401, got ${answerNoToken.status}`);
const answerForeign = await fetch(`${BASE}/api/credential-requests/${deduped[0].id}/approve`, {
  method: 'POST', headers: { ...credHeaders, origin: 'https://evil.example' },
});
if (answerForeign.status !== 403) fail(`a cross-origin page must not approve a request, got ${answerForeign.status}`);
ok('answering an access request refuses no-token and cross-origin callers');

// Deny clears the request and grants nothing.
const denied = await (await fetch(`${BASE}/api/credential-requests/${deduped[0].id}/deny`, {
  method: 'POST', headers: credHeaders,
})).json();
if (!denied.ok || denied.granted !== false) fail(`deny should resolve without granting: ${JSON.stringify(denied)}`);
const afterDeny = await (await fetch(`${BASE}/api/credential-requests`)).json();
if (afterDeny.requests.some((r) => r.id === deduped[0].id)) fail('a denied request should be gone from the list');
const stillDenied = await mcp(allowed.token, 'tools/call', { name: 'hypergate__credential_env', arguments: { id: cred.id } });
if (!(stillDenied.body?.error || stillDenied.body?.result?.isError)) fail('deny must not have granted access');
ok('deny clears the request and grants nothing');

// Approve flips the same grant the per-agent switch does.
const reAsked = await mcp(allowed.token, 'tools/call', { name: 'hypergate__credential_request', arguments: { id: cred.id } });
const reAskedId = (await (await fetch(`${BASE}/api/credential-requests`)).json())
  .requests.find((r) => r.credentialId === cred.id && r.agentId === allowed.id)?.id;
if (!reAskedId) fail(`re-asking should file a fresh request: ${JSON.stringify(reAsked.body)}`);
const approved = await (await fetch(`${BASE}/api/credential-requests/${reAskedId}/approve`, {
  method: 'POST', headers: credHeaders,
})).json();
if (!approved.ok || approved.granted !== true) fail(`approve should grant: ${JSON.stringify(approved)}`);
const afterApprove = await mcp(allowed.token, 'tools/call', { name: 'hypergate__credential_env', arguments: { id: cred.id } });
if (JSON.parse(afterApprove.body?.result?.content?.[0]?.text ?? '{}').env?.SMOKE_TOKEN !== SECRET_VALUE)
  fail(`the agent should be able to fetch after approval: ${JSON.stringify(afterApprove.body)}`);
// Already granted: asking again must say so rather than filing a pointless request.
const askGranted = JSON.parse(
  (await mcp(allowed.token, 'tools/call', { name: 'hypergate__credential_request', arguments: { id: cred.id } }))
    .body?.result?.content?.[0]?.text ?? '{}',
);
if (askGranted.filed !== false || askGranted.allowed !== true) fail(`requesting an already-granted key should be a no-op: ${JSON.stringify(askGranted)}`);
ok('approve grants exactly that credential, and requesting a granted one files nothing');

// Revoke again so the rest of the script sees the pre-approval state.
await fetch(`${BASE}/api/clients/${allowed.id}/credentials/${cred.id}`, {
  method: 'POST', headers: credHeaders, body: JSON.stringify({ allowed: false }),
});

// The gateway tells a connecting agent that the vault exists. Without this an
// agent has to guess that a local keystore might hold the token it needs.
const initialized = await mcp(allowed.token, 'initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' },
});
const instructions = initialized.body?.result?.instructions ?? '';
if (!instructions.includes('credentials_list') || !instructions.includes('credential_request'))
  fail(`initialize should carry instructions naming the credential tools: ${JSON.stringify(initialized.body?.result)}`);
ok('the gateway advertises the vault in its MCP instructions');

// The reveal door. No consent prompt is available in CI, and the smoke daemon
// has no shell binary, so the honest outcome is a refusal — never the value.
const revealNoToken = await fetch(`${BASE}/api/credentials/${cred.id}/reveal`, { method: 'POST' });
if (revealNoToken.status !== 401) fail(`reveal without the master token should 401, got ${revealNoToken.status}`);
const revealForeign = await fetch(`${BASE}/api/credentials/${cred.id}/reveal`, {
  method: 'POST', headers: { ...credHeaders, origin: 'https://evil.example' },
});
if (revealForeign.status !== 403) fail(`a cross-origin page must not reveal a value, got ${revealForeign.status}`);
const revealUnknown = await fetch(`${BASE}/api/credentials/no-such-cred/reveal`, { method: 'POST', headers: credHeaders });
if (revealUnknown.status !== 404) fail(`revealing an unknown credential should 404, got ${revealUnknown.status}`);
const revealRes = await fetch(`${BASE}/api/credentials/${cred.id}/reveal`, { method: 'POST', headers: credHeaders });
const revealBody = await revealRes.json();
if (revealRes.status === 200) {
  // Only reachable where a real consent prompt said yes, which cannot happen
  // unattended. If it does, the value must at least be the right one.
  if (revealBody.value !== SECRET_VALUE) fail(`an authorized reveal returned the wrong value: ${JSON.stringify(revealBody)}`);
  ok('reveal returned the value after an OS consent prompt');
} else {
  if (revealBody.authorized !== false) fail(`an unauthorized reveal must say so: ${JSON.stringify(revealBody)}`);
  if (JSON.stringify(revealBody).includes(SECRET_VALUE)) fail('a refused reveal leaked the value');
  ok(`reveal fails closed without OS consent (${revealRes.status}, ${revealBody.reason})`);
}

const grant = await fetch(`${BASE}/api/clients/${allowed.id}/credentials/${cred.id}`, {
  method: 'POST', headers: credHeaders, body: JSON.stringify({ allowed: true }),
});
if (grant.status !== 200) fail(`granting the credential failed: ${grant.status}`);
const grantUnknown = await fetch(`${BASE}/api/clients/${allowed.id}/credentials/nope`, {
  method: 'POST', headers: credHeaders, body: JSON.stringify({ allowed: true }),
});
if (grantUnknown.status !== 404) fail(`granting an unknown credential should 404, got ${grantUnknown.status}`);
const grantedEnv = await mcp(allowed.token, 'tools/call', { name: 'hypergate__credential_env', arguments: { id: cred.id } });
const grantedPayload = JSON.parse(grantedEnv.body?.result?.content?.[0]?.text ?? '{}');
if (grantedPayload.env?.SMOKE_TOKEN !== SECRET_VALUE) fail(`a granted agent should receive the env: ${JSON.stringify(grantedEnv.body)}`);
ok('a one-flip grant lets the agent fetch the credential as env (and the fetch is recorded)');

// The hypergate run door: master resolves everything; an agent's scope holds.
const resolveMaster = await (await fetch(`${BASE}/api/credentials/resolve`, {
  method: 'POST', headers: credHeaders, body: JSON.stringify({}),
})).json();
if (resolveMaster.env?.SMOKE_TOKEN !== SECRET_VALUE) fail(`master resolve missing the env: ${JSON.stringify(resolveMaster.used)}`);
const resolveDenied = await fetch(`${BASE}/api/credentials/resolve`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${blocked.token}` },
  body: JSON.stringify({ ids: [cred.id] }),
});
if (resolveDenied.status !== 403) fail(`an ungranted agent's resolve should 403, got ${resolveDenied.status}`);
const resolveAs = await (await fetch(`${BASE}/api/credentials/resolve`, {
  method: 'POST', headers: credHeaders, body: JSON.stringify({ agent: 'echo-agent' }),
})).json();
if (resolveAs.env?.SMOKE_TOKEN !== SECRET_VALUE) fail(`master resolving as the granted agent should get the env: ${JSON.stringify(resolveAs)}`);
ok('resolve honours scope: master all, an ungranted agent 403, master-as-agent its allow-list');

// Roll: value replaced in place, the referencing server restarted onto it.
const ROLLED_VALUE = 'smoke_fly_v2_fedcba9876543210';
const rolledCred = await (await fetch(`${BASE}/api/credentials/${cred.id}/roll`, {
  method: 'POST', headers: credHeaders, body: JSON.stringify({ value: ROLLED_VALUE }),
})).json();
if (!rolledCred.rotatedAt || !(rolledCred.restarted ?? []).includes('envprobe')) fail(`roll should stamp rotatedAt and restart envprobe: ${JSON.stringify(rolledCred)}`);
const probeEnv2 = await mcp(master, 'tools/call', { name: 'envprobe__env', arguments: { name: 'SMOKE_TOKEN' } });
if (probeEnv2.body?.result?.content?.[0]?.text !== ROLLED_VALUE) fail(`the restarted server should see the rolled value: ${JSON.stringify(probeEnv2.body)}`);
ok('rolling replaces the value and restarts the servers that reference it');

// Delete means deleted: value, grants, and server references all go.
const credDelete = await (await fetch(`${BASE}/api/credentials/${cred.id}`, {
  method: 'DELETE', headers: credHeaders,
})).json();
if (!credDelete.ok || !credDelete.servers.includes('envprobe') || !credDelete.agents.includes(allowed.id))
  fail(`delete should prune refs and grants: ${JSON.stringify(credDelete)}`);
const afterDelete = await (await fetch(`${BASE}/api/credentials`)).json();
if (afterDelete.some((c) => c.id === cred.id)) fail('the credential is still listed after delete');
const goneEnv = await mcp(allowed.token, 'tools/call', { name: 'hypergate__credential_env', arguments: { id: cred.id } });
if (!(goneEnv.body?.error || goneEnv.body?.result?.isError)) fail('a deleted credential must not be fetchable');
ok('delete removes the credential, every agent grant, and every server reference');

// Keep a credential around to prove the vault survives the restart below.
const keeper = await (await fetch(`${BASE}/api/credentials`, {
  method: 'POST', headers: credHeaders,
  body: JSON.stringify({ name: 'Keeper token', value: 'keeper_value_123456', envVar: 'KEEPER_TOKEN' }),
})).json();
if (!keeper.id) fail(`keeper credential create failed: ${JSON.stringify(keeper)}`);
await fetch(`${BASE}/api/servers/envprobe/stop`, { method: 'POST' });

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

// The vault survives too: metadata, the stored value, and resolvability.
const credsAfter = await (await fetch(`${BASE}/api/credentials`)).json();
if (!credsAfter.some((c) => c.id === keeper.id)) fail('the vault lost a credential across the restart');
const keeperResolved = await (await fetch(`${BASE}/api/credentials/resolve`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${await gwToken()}` },
  body: JSON.stringify({ ids: [keeper.id] }),
})).json();
if (keeperResolved.env?.KEEPER_TOKEN !== 'keeper_value_123456') fail(`the stored value did not survive the restart: ${JSON.stringify(keeperResolved)}`);
ok('the credential vault survived the restart (metadata + value)');

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
