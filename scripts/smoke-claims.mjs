// Smoke test for the claims hypergate.app makes, end to end against a real
// daemon on a scratch port and data dir:
//   1. per-tool permissions (read-only mode and one blocked tool),
//   2. the secret guard (a vault value in a tool call's arguments is refused),
//   3. insights and the audit_review tool,
//   4. the opt-in team listener (person tokens only, gateway only).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdown, removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7883;
const TEAM_PORT = 7893;
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'hypergate-claims-'));
const ECHO = join(ROOT, 'packages/core/src/fixtures/echo-server.mjs');

const ok = (m) => console.log(`✓ ${m}`);
let daemon;
const fail = async (m) => {
  console.error(`✗ ${m}`);
  await shutdown(daemon, DIR);
  process.exit(1);
};

daemon = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'apps/daemon/src/index.ts')], {
  env: {
    ...process.env,
    HYPERGATE_DIR: DIR,
    HYPERGATE_PORT: String(PORT),
    PORT: String(PORT),
    HYPERGATE_NO_KEYCHAIN: '1',
    HYPERGATE_NO_AUTHORIZE: '1',
    HYPERGATE_NO_WATCH: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
daemon.stderr.on('data', (x) => process.stderr.write(x));
let up = false;
for (let i = 0; i < 80 && !up; i++) {
  up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) await fail('daemon did not come up');

const post = (path, body, token, method = 'POST') =>
  fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const master = (await (await fetch(`${BASE}/api/gateway`)).json()).token;
let rpcId = 0;
const mcp = async (base, token, method, params) => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};
const session = async (base, token) => {
  await mcp(base, token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
};
const toolNames = async (base, token) => ((await mcp(base, token, 'tools/list', {})).body?.result?.tools ?? []).map((t) => t.name);
const callErr = (r) => r.body?.error?.message ?? (r.body?.result?.isError ? r.body.result.content?.[0]?.text : undefined);

const added = await (await post('/api/servers', { id: 'echo', name: 'Echo', runtime: 'process', command: process.execPath, args: [ECHO], enabled: true })).json();
if (added.state !== 'ready') await fail(`echo not ready: ${JSON.stringify(added)}`);
ok('echo server ready');

// ── 1. per-tool permissions ────────────────────────────────────────────────
const agent = await (await post('/api/clients', { name: 'Scoped', servers: '*' })).json();
await session(BASE, agent.token);
let names = await toolNames(BASE, agent.token);
if (!names.includes('echo__echo') || !names.includes('echo__peek')) await fail(`unscoped agent should see both tools: ${names}`);
await post(`/api/clients/${agent.id}/tools`, { readOnly: true });
names = await toolNames(BASE, agent.token);
if (names.includes('echo__echo') || !names.includes('echo__peek')) await fail(`read-only agent should see only peek: ${names}`);
const roCall = await mcp(BASE, agent.token, 'tools/call', { name: 'echo__echo', arguments: { text: 'x' } });
if (!/read-only/.test(callErr(roCall) ?? '')) await fail(`read-only call should be refused: ${JSON.stringify(roCall.body)}`);
ok('read-only mode hides and refuses a tool not declared read-only');
await post(`/api/clients/${agent.id}/tools`, { readOnly: false });
await post(`/api/clients/${agent.id}/tools`, { tool: 'echo__peek', allowed: false });
names = await toolNames(BASE, agent.token);
if (names.includes('echo__peek') || !names.includes('echo__echo')) await fail(`blocked tool should be hidden: ${names}`);
ok('one blocked tool is hidden; its neighbour is not');
const listed = await (await fetch(`${BASE}/api/clients`)).json();
if (JSON.stringify(listed.find((c) => c.id === agent.id)?.tools) !== JSON.stringify({ blocked: ['echo__peek'] })) await fail('tool policy not persisted on the agent');
await post(`/api/clients/${agent.id}/tools`, { tool: 'echo__peek', allowed: true });

// ── 2. secret guard ────────────────────────────────────────────────────────
const SECRET = 'sk_smoke_0123456789abcdef';
const cred = await post('/api/credentials', { name: 'Smoke key', value: SECRET, envVar: 'SMOKE_KEY' }, master);
if (!cred.ok) await fail(`credential create failed: ${cred.status} ${await cred.text()}`);
const leak = await mcp(BASE, agent.token, 'tools/call', { name: 'echo__echo', arguments: { text: `send ${SECRET} please` } });
if (!/Smoke key/.test(callErr(leak) ?? '')) await fail(`a call carrying a vault value should be refused: ${JSON.stringify(leak.body)}`);
ok('a tool call carrying a vault value is refused before it reaches the server');
const events = await (await fetch(`${BASE}/api/usage/events?limit=50`)).json();
if (JSON.stringify(events).includes(SECRET)) await fail('the secret leaked into the usage log');
if (!events.some((e) => e.blocked === 'secret')) await fail('blocked call not recorded with blocked=secret');
ok('the refusal is in the audit log, without the value');

// ── 3. insights and audit_review ───────────────────────────────────────────
const insights = await (await fetch(`${BASE}/api/insights`)).json();
if (!insights.insights.some((i) => i.rule === 'secret-blocked' && i.severity === 'high')) await fail(`no secret-blocked insight: ${JSON.stringify(insights)}`);
ok(`insights raise the blocked key (${insights.insights.length} insight(s), ${insights.blocked} blocked)`);
await session(BASE, master);
if (!(await toolNames(BASE, master)).includes('hypergate__audit_review')) await fail('master should have audit_review');
const review = await mcp(BASE, master, 'tools/call', { name: 'hypergate__audit_review', arguments: { hours: 24 } });
const digest = JSON.parse(review.body?.result?.content?.[0]?.text ?? '{}');
if (!(digest.totals?.blocked >= 1) || !digest.callers?.some((c) => c.name === 'Scoped')) await fail(`audit_review digest wrong: ${JSON.stringify(digest).slice(0, 300)}`);
ok('audit_review gives the agent a digest with callers, blocked calls and insights');
const scopedAgent = await (await post('/api/clients', { name: 'Narrow', servers: ['echo'] })).json();
await session(BASE, scopedAgent.token);
if ((await toolNames(BASE, scopedAgent.token)).includes('hypergate__audit_review')) await fail('a scoped agent must not get audit_review');
ok('a scoped agent does not get audit_review');

// ── 4. team listener ───────────────────────────────────────────────────────
const off = await (await fetch(`${BASE}/api/team`)).json();
if (off.enabled || off.listening) await fail(`team access should be off by default: ${JSON.stringify(off)}`);
const unauth = await post('/api/team', { enabled: true, host: '127.0.0.2' }, undefined, 'PUT');
if (unauth.status !== 401) await fail(`enabling team access without the master token should 401, got ${unauth.status}`);
const wildcard = await post('/api/team', { enabled: true, host: '0.0.0.0' }, master, 'PUT');
if (wildcard.status !== 400) await fail(`a wildcard bind should be refused, got ${wildcard.status}`);
// 127.0.0.2 is loopback on Linux and Windows but not a name the main listener
// uses, so it stands in for a LAN address without exposing anything.
const host = process.platform === 'darwin' ? null : '127.0.0.2';
if (host) {
  const on = await (await post('/api/team', { enabled: true, host, port: TEAM_PORT }, master, 'PUT')).json();
  if (!on.listening) await fail(`team listener did not start: ${JSON.stringify(on)}`);
  const TEAM = `http://${host}:${TEAM_PORT}`;
  const person = await (await post('/api/clients', { name: 'Ada', servers: ['echo'], kind: 'person' })).json();
  if (person.kind !== 'person') await fail('person kind not stored');
  for (const [label, tok] of [['master', master], ['agent', agent.token]]) {
    const r = await mcp(TEAM, tok, 'tools/list', {});
    if (r.status !== 401) await fail(`team listener accepted the ${label} token (${r.status})`);
  }
  ok('the team listener refuses master and agent tokens');
  await session(TEAM, person.token);
  const pNames = await toolNames(TEAM, person.token);
  if (!pNames.includes('echo__echo') || pNames.some((n) => n.startsWith('hypergate__'))) await fail(`person tool list wrong: ${pNames}`);
  const said = await mcp(TEAM, person.token, 'tools/call', { name: 'echo__echo', arguments: { text: 'hi from the team' } });
  if (said.body?.result?.content?.[0]?.text !== 'hi from the team') await fail(`person call failed: ${JSON.stringify(said.body)}`);
  ok('a person token works over the team listener, with no vault or install tools');
  const api = await fetch(`${TEAM}/api/clients`, { headers: { authorization: `Bearer ${person.token}` } });
  if (api.status !== 404) await fail(`team listener served the API (${api.status})`);
  ok('the team listener serves nothing but /mcp');
  const offAgain = await (await post('/api/team', { enabled: false }, master, 'PUT')).json();
  if (offAgain.listening) await fail('team listener did not stop');
  const gone = await fetch(`${TEAM}/mcp`, { method: 'POST' }).then(() => 'answered').catch(() => 'closed');
  if (gone !== 'closed') await fail('team port still answering after disable');
  ok('turning team access off closes the port');
} else {
  console.log('- team listener live checks skipped on macOS (no 127.0.0.2 by default)');
}

await shutdown(daemon, DIR);
console.log('\nclaims smoke: all green');
