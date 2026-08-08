// Smoke test for the Rust shell ↔ daemon bridge (v0.8 features).
//
// Covers the seam that unit tests cannot: the daemon delegating to the real
// `hypergate` binary for keychain and login-item work, the CLI reading the
// daemon's HTTP API, and a managed MCP server actually launched through
// `sandbox-exec` with OS resource limits applied.
//
// Requires the shell to be built: cd apps/shell && cargo build --release
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shutdown, removeDir } from './smoke-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7879;
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'hypergate-shell-'));
const ECHO = join(ROOT, 'packages/core/src/fixtures/echo-server.mjs');

// A keychain is machine-global, so namespace this run's entries. Without this we
// would overwrite the developer's real gateway token.
const NAMESPACE = `smoke-${process.pid}`;
const EXE = process.platform === 'win32' ? 'hypergate.exe' : 'hypergate';
const BIN = ['release', 'debug']
  .map((p) => join(ROOT, 'apps/shell/target', p, EXE))
  .find((p) => existsSync(p));

const ok = (m) => console.log(`✓ ${m}`);
let daemon;
const cleanup = () => {
  // Remove this run's keychain entries so nothing is left in the user's store.
  if (BIN) {
    for (const key of ['gateway-token', 'oauth:echo']) {
      try {
        hg(['secret', 'delete', key]);
      } catch {
        /* already gone */
      }
    }
  }
  removeDir(DIR);
};
const fail = (m) => {
  console.error(`✗ ${m}`);
  if (daemon) daemon.kill();
  cleanup();
  process.exit(1);
};

if (!BIN) fail('shell binary not built — run: cd apps/shell && cargo build --release');

/** Run the shell binary, returning trimmed stdout. */
const hg = (args, opts = {}) =>
  execFileSync(BIN, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, HYPERGATE_DIR: DIR, HYPERGATE_PORT: String(PORT), HYPERGATE_KEYCHAIN_NAMESPACE: NAMESPACE },
    ...opts,
  }).trim();

const env = {
  ...process.env,
  HYPERGATE_DIR: DIR,
  PORT: String(PORT),
  HYPERGATE_KEYCHAIN_NAMESPACE: NAMESPACE,
  // Point the daemon at the binary we just built, rather than PATH.
  HYPERGATE_SHELL_BIN: BIN,
};

const boot = async () => {
  const d = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'apps/daemon/src/index.ts')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  d.stderr.on('data', (b) => process.stderr.write(b));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await (await fetch(`${BASE}/health`)).json()).ok) return d;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  fail('daemon did not come up');
};

// ── the shell binary itself ─────────────────────────────────────────────────
if (hg(['secret', 'check']) !== 'available') fail('no usable keychain on this machine');
ok('keychain available');

daemon = await boot();
ok('daemon up with the shell bridge configured');

// ── the gateway token lives in the keychain, not on disk ────────────────────
const gateway = await (await fetch(`${BASE}/api/gateway`)).json();
if (!gateway.token) fail('no gateway token in /api/gateway');
const fromKeychain = hg(['secret', 'get', 'gateway-token']);
if (fromKeychain !== gateway.token) fail(`keychain token does not match the daemon's (${fromKeychain.length} vs ${gateway.token.length} chars)`);
ok('gateway token stored in the OS keychain and matches the daemon');

if (existsSync(join(DIR, 'gateway-token'))) fail('a plaintext gateway-token file was written despite a working keychain');
ok('no plaintext gateway-token file on disk');

// ── autostart is now reported per-platform, not Windows-only ────────────────
const settings = await (await fetch(`${BASE}/api/settings`)).json();
if (settings.startupSupported !== true) fail(`startupSupported should be true when the shell is present, got ${settings.startupSupported}`);
if (settings.runOnStartup !== false) fail('runOnStartup should start out false in a scratch environment');
ok(`autostart reported as supported on ${settings.platform}`);

// ── a managed server launched through sandbox-exec with real limits ─────────
const added = await (
  await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'echo',
      name: 'Echo',
      runtime: 'process',
      command: process.execPath,
      args: [ECHO],
      enabled: true,
      limits: { memMb: 512 },
    }),
  })
).json();
if (added.state !== 'ready') fail(`sandboxed echo server did not reach ready: ${JSON.stringify(added)}`);
ok('MCP server started through sandbox-exec and reached ready (stdio survived the extra process)');

const logs = await (await fetch(`${BASE}/api/servers/echo/logs`)).json();
const enforced = (logs.logs ?? []).find((l) => l.includes('resource limits enforced via sandbox-exec'));
if (!enforced) fail(`no enforcement log line; got: ${JSON.stringify(logs.logs)}`);
if ((logs.logs ?? []).some((l) => l.includes('UNSANDBOXED'))) fail('server reported itself unsandboxed');
ok(`limits confirmed enforced: "${enforced}"`);

// The whole point: a real tool call has to round-trip through the launcher.
const mcp = async (method, params) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${gateway.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  return res.json();
};
await mcp('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-shell', version: '1' },
});
const call = await mcp('tools/call', { name: 'echo__echo', arguments: { text: 'through-the-sandbox' } });
if (call?.result?.content?.[0]?.text !== 'through-the-sandbox')
  fail(`tools/call through the sandbox failed: ${JSON.stringify(call)}`);
ok('tools/call routed through the sandboxed server and returned correctly');

// ── the CLI as a client of the same API ────────────────────────────────────
const status = hg(['status']);
if (!status.includes('running')) fail(`hypergate status did not see the daemon:\n${status}`);
if (!/Keychain\s+available/.test(status)) fail(`hypergate status did not report the keychain:\n${status}`);
ok('hypergate status reports the running daemon, usage and keychain');

const list = hg(['list']);
if (!list.includes('echo') || !list.includes('ready')) fail(`hypergate list missing the echo server:\n${list}`);
ok('hypergate list shows the managed server and its state');

if (hg(['gateway', '--token-only']) !== gateway.token) fail('hypergate gateway --token-only disagrees with the daemon');
ok('hypergate gateway --token-only matches the daemon');

const cliLogs = hg(['logs', 'echo']);
if (!cliLogs.includes('sandbox-exec')) fail(`hypergate logs did not return the server log:\n${cliLogs}`);
ok('hypergate logs streams the durable server log');

const doctor = JSON.parse(hg(['doctor', '--json']));
if (!doctor.ok || !doctor.data?.daemon?.running) fail(`doctor --json did not report the daemon: ${JSON.stringify(doctor)}`);
ok('hypergate doctor --json reports daemon posture');

const addedAgent = JSON.parse(hg(['--json', 'agent', 'add', 'smoke-agent']));
const agentId = addedAgent.data?.id;
if (!addedAgent.ok || !agentId) fail(`agent add failed: ${JSON.stringify(addedAgent)}`);
ok('hypergate agent add creates a scoped agent');

const allowed = JSON.parse(hg(['--json', 'agent', 'allow', agentId, 'echo']));
if (!allowed.ok) fail(`agent allow failed: ${JSON.stringify(allowed)}`);
ok('hypergate agent allow updates one server scope');

const tokenRaw = execFileSync(BIN, ['agent', 'token', agentId], {
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
  env: { ...process.env, HYPERGATE_DIR: DIR, HYPERGATE_PORT: String(PORT), HYPERGATE_KEYCHAIN_NAMESPACE: NAMESPACE },
});
if (!tokenRaw || tokenRaw.endsWith('\n') || tokenRaw.endsWith('\r')) fail('agent token printed a trailing newline');
ok('hypergate agent token prints an exact token');

const rotated = JSON.parse(hg(['--json', 'agent', 'rotate', agentId]));
if (!rotated.ok || rotated.data?.token === tokenRaw) fail(`agent rotate failed to mint a new token: ${JSON.stringify(rotated)}`);
ok('hypergate agent rotate preserves the agent while changing its token');

const removedAgent = JSON.parse(hg(['--json', 'agent', 'rm', agentId]));
if (!removedAgent.ok) fail(`agent rm failed: ${JSON.stringify(removedAgent)}`);
ok('hypergate agent rm removes the agent');

const clis = JSON.parse(hg(['cli', 'ls', '--json']));
if (!clis.ok || !Array.isArray(clis.data)) fail(`cli ls --json returned an unexpected shape: ${JSON.stringify(clis)}`);
ok('hypergate cli ls --json returns catalog status');

// ── durable state survives, and the token is not re-minted ─────────────────
await new Promise((r) => setTimeout(r, 2300)); // let the debounced writer flush
daemon.kill();
await new Promise((r) => setTimeout(r, 700));
daemon = await boot();
const after = await (await fetch(`${BASE}/api/gateway`)).json();
if (after.token !== gateway.token) fail('the gateway token changed across a restart (keychain not being read back)');
ok('gateway token read back from the keychain across a restart');
if (existsSync(join(DIR, 'hypergate.db'))) ok('SQLite store present at ~/.hypergate/hypergate.db');
else fail('no SQLite database was created');

await shutdown(daemon, DIR);
cleanup();
console.log('\nShell bridge smoke: all green');
process.exit(0);
