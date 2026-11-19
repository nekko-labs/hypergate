// Smoke test for the ambient sweep, the watcher and team alerts.
// Boots the daemon on a scratch port, data dir AND home (HYPERGATE_AMBIENT_HOME),
// so it never reads or edits the developer's real shell files, with a local
// HTTP receiver standing in for the team webhook.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdown, removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7900 + Math.floor(Math.random() * 80);
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'hypergate-ambient-'));
const HOME = join(DIR, 'home');
const DATA = join(DIR, 'data');
mkdirSync(HOME, { recursive: true });
const OPENAI = 'sk-proj-SMOKEabcdefghijklmnopqrstuvwxyz0123';
writeFileSync(join(HOME, '.zshrc'), `alias ll='ls -l'\nexport OPENAI_API_KEY="${OPENAI}"\n`);

let daemon;
let hook;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  console.error(`✗ ${m}`);
  if (daemon) daemon.kill();
  if (hook) hook.close();
  removeDir(DIR);
  process.exit(1);
};

// The team webhook: records every body it receives.
const received = [];
hook = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push(JSON.parse(body || '{}'));
    res.writeHead(200).end('ok');
  });
});
await new Promise((r) => hook.listen(0, '127.0.0.1', r));
const HOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;

daemon = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'apps/daemon/src/index.ts')], {
  env: {
    ...process.env,
    HYPERGATE_DIR: DATA,
    PORT: String(PORT),
    HYPERGATE_NO_KEYCHAIN: '1',
    HYPERGATE_NO_AUTHORIZE: '1',
    HYPERGATE_NO_NOTIFY: '1',
    HYPERGATE_AMBIENT_HOME: HOME,
    HYPERGATE_WATCH_INTERVAL_MS: '400',
    HYPERGATE_ALERT_WINDOW_MS: '150',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
daemon.stderr.on('data', (x) => process.stderr.write(x));
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) fail('daemon did not come up');
const master = (await (await fetch(`${BASE}/api/gateway`)).json()).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { authorization: `Bearer ${master}`, 'content-type': 'application/json' };

// The watcher's first pass records a baseline and alerts on nothing; wait for
// it so the changes made below are measured against this starting state.
for (let i = 0; i < 50; i++) {
  if ((await (await fetch(`${BASE}/api/watch/events`)).json()).lastPassAt) break;
  await sleep(100);
}

// ── the sweep ────────────────────────────────────────────────────────────────
const scan = await (await fetch(`${BASE}/api/ambient`)).json();
const finding = scan.findings.find((f) => f.envVar === 'OPENAI_API_KEY');
if (!finding) fail(`the sweep did not find the rc key: ${JSON.stringify(scan)}`);
if (JSON.stringify(scan).includes(OPENAI)) fail('the sweep response carried a value');
if (finding.service !== 'openai' || !finding.importable || finding.removal !== 'edit') fail(`unexpected finding ${JSON.stringify(finding)}`);
ok(`sweep found ${finding.tool} ${finding.detail} (hint ${finding.hint}), no value in the response`);

// ── import: master only, vault first, then the line out ─────────────────────
const anon = await fetch(`${BASE}/api/ambient/${finding.id}/import`, { method: 'POST' });
if (anon.status !== 401) fail(`import without the master token should 401, got ${anon.status}`);
const imp = await (await fetch(`${BASE}/api/ambient/${finding.id}/import`, { method: 'POST', headers: auth })).json();
if (!imp.ok || !imp.removed || imp.vault !== 'created') fail(`import failed: ${JSON.stringify(imp)}`);
const rc = readFileSync(join(HOME, '.zshrc'), 'utf8');
if (rc.includes(OPENAI) || !rc.includes('hypergate: OPENAI_API_KEY moved')) fail(`rc file not edited: ${rc}`);
const resolved = await (await fetch(`${BASE}/api/credentials/resolve`, { method: 'POST', headers: auth, body: JSON.stringify({ ids: [imp.credentialId] }) })).json();
if (resolved.env.OPENAI_API_KEY !== OPENAI) fail('the imported value is not what the vault hands out');
ok(`import moved it into the vault as ${imp.credentialId} and edited the rc line (backup ${imp.backup ? 'kept' : 'missing'})`);

// ── alert settings: master only, the URL never comes back ───────────────────
const noTok = await fetch(`${BASE}/api/settings`, { method: 'PATCH', body: JSON.stringify({ alertWebhookUrl: HOOK_URL }) });
if (noTok.status !== 401) fail(`setting the webhook without the master token should 401, got ${noTok.status}`);
const set = await (await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: auth, body: JSON.stringify({ alertWebhookUrl: HOOK_URL, alertWebhookFormat: 'json' }) })).json();
if (!set.alertWebhookConfigured || JSON.stringify(set).includes(HOOK_URL)) fail(`settings leaked or lost the webhook: ${JSON.stringify(set)}`);
const test = await (await fetch(`${BASE}/api/alerts/test`, { method: 'POST', headers: auth })).json();
if (test.webhook !== true || received.length !== 1 || received[0].test !== true) fail(`test alert did not arrive: ${JSON.stringify(test)}`);
ok(`webhook stored (shown as ${set.alertWebhookHint}) and the test alert arrived`);

// ── the watcher: a new key and a new CLI become one coalesced team alert ────
writeFileSync(join(HOME, '.bashrc'), 'export OPENROUTER_API_KEY=sk-or-v1-SMOKE0123456789abcdef\n');
mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
writeFileSync(join(HOME, '.local', 'bin', 'sneaky-cli'), '');
for (let i = 0; i < 30 && received.length < 2; i++) await sleep(200);
if (received.length < 2) fail(`the watcher did not alert the team webhook: ${JSON.stringify(await (await fetch(`${BASE}/api/watch/events`)).json())}`);
const alert = received[1];
const kinds = alert.events.map((e) => `${e.kind}:${e.tool}`).sort();
if (!kinds.includes('ambient-new:Shell startup file') || !kinds.includes('cli-new:sneaky-cli')) fail(`unexpected alert ${JSON.stringify(alert)}`);
if (JSON.stringify(received).includes('sk-or-v1')) fail('a webhook body carried a value');
const events = await (await fetch(`${BASE}/api/watch/events`)).json();
if (!events.events.some((e) => e.kind === 'ambient-imported')) fail('the import was not recorded as an event');
ok(`watcher raised ${kinds.join(', ')} in one webhook call, with no value in it`);

// ── auto-quarantine ──────────────────────────────────────────────────────────
await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: auth, body: JSON.stringify({ autoQuarantine: true }) });
writeFileSync(join(HOME, '.profile'), 'export ANTHROPIC_API_KEY=sk-ant-api03-SMOKE0123456789abcdef\n');
for (let i = 0; i < 30 && readFileSync(join(HOME, '.profile'), 'utf8').includes('sk-ant'); i++) await sleep(200);
if (readFileSync(join(HOME, '.profile'), 'utf8').includes('sk-ant')) fail('auto-quarantine did not move the new key');
for (let i = 0; i < 20 && received.length < 3; i++) await sleep(200);
if (!received[2]?.events?.some((e) => e.quarantined)) fail(`the alert did not say it was quarantined: ${JSON.stringify(received[2])}`);
ok('auto-quarantine moved a newly written key into the vault and the alert says so');

hook.close();
await shutdown(daemon, DIR);
console.log('\nAmbient smoke: all green');
process.exit(0);
