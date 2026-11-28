// Run against three isolated production previews; all daemon and collector traffic is simulated.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:4530';
const configured = 'http://127.0.0.1:4531';
const unconfigured = 'http://127.0.0.1:4532';
const collector = 'https://us.i.posthog.com/i/v0/e/';
const choiceKey = 'hypergate.analytics.manager.v1.choice';
const idKey = 'hypergate.analytics.manager.v1.id';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fixtureId = '00000000-0000-4000-8000-000000000140';
const serverName = 'Fixture private server';
const fixtureAgent = { id: 'fixture-agent', name: 'Fixture private agent', target: 'fixture-client', servers: '*', token: 'fixture-agent-token' };
const target = { id: 'fixture-client', name: 'Fixture CLI', method: 'cli', found: true, command: 'fixture-cli', commands: { bash: 'fixture-cli private-command' } };
const update = { current: '1.36.0', latest: '1.36.0', updateAvailable: false, canApply: false, channel: 'repo' };
const fixtures = {
  '/health': { ok: true, version: update.current, servers: 1 },
  '/api/settings': { platform: 'darwin', startupSupported: true, startupVia: 'shell', runOnStartup: false, startMinimized: false, closeAction: 'ask' },
  '/api/gateway': { url: 'http://127.0.0.1:7777/mcp', stdioCommand: 'hypergate mcp', clientSnippet: {} },
  '/api/update': update, '/api/update/check': update, '/api/update/progress': { stage: 'idle', received: 0 },
  '/api/registry': [], '/api/registry/popularity': {}, '/api/clients': [fixtureAgent],
  '/api/credential-requests': { requests: [] }, '/api/cli-requests': { requests: [] }, '/api/server-requests': { requests: [] },
  '/api/credentials': [], '/api/credentials/guides': [], '/api/clis': [], '/api/instructions': { harnesses: [] },
  '/api/lockdown': { enabled: false, presence: { available: false } },
  '/api/connect/targets': { targets: [target] },
  '/api/clients/fixture-agent/connect': { target: target.id, targets: [target], defaultShell: 'bash', shells: ['bash'], entryName: 'fixture-entry' },
  '/api/team': { settings: { enabled: false }, addresses: [] },
  '/api/analytics': { since: '2026-11-27T00:00:00Z', totalCalls: 0, totalErrors: 0, bytesIn: 0, bytesOut: 0, servers: [], clients: [], recent: [], series: [] },
};

async function harness(browser, origin, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1200, height: 820 },
    deviceScaleFactor: opts.scale || 1, colorScheme: opts.theme || 'dark',
    reducedMotion: opts.motion ? 'no-preference' : 'reduce', serviceWorkers: 'block',
  });
  await ctx.addInitScript(({ shell, theme, seeded, signal }) => {
    if (shell) window.__hypergateShell = { platform: 'macos', buttons: false, titleBarHeight: 52 };
    const setTheme = () => { document.documentElement.dataset.theme = theme; };
    if (document.documentElement) setTheme();
    else document.addEventListener('DOMContentLoaded', setTheme, { once: true });
    if (signal) Object.defineProperty(navigator, signal, { value: signal === 'globalPrivacyControl' ? true : '1' });
    if (seeded) for (const [key, value] of Object.entries(seeded)) localStorage.setItem(key, value);
  }, { shell: opts.shell !== false, theme: opts.theme || 'dark', seeded: opts.seeded, signal: opts.signal });
  const reports = [], unexpected = [], errors = [], mutations = [];
  const state = { fail: false, collectorOffline: false, server: {
    id: 'fixture-server', name: serverName, runtime: 'process', state: 'stopped', tools: [], restarts: 0, lastLog: 'fixture private log',
  } };
  ctx.on('request', (req) => { if (new URL(req.url()).hostname.endsWith('.posthog.com')) reports.push(req); });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.href === collector && req.method() === 'POST') {
      if (state.collectorOffline) return route.abort();
      return route.fulfill({ status: 200, json: { status: 1 }, headers: { 'access-control-allow-origin': '*' } });
    }
    // Only Vite static files are allowed to escape interception; no real daemon is contacted.
    if (url.origin !== origin) { unexpected.push(req.url()); return route.abort(); }
    if (url.pathname === '/test-embedded') return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><iframe title="Fixture frame" src="/" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>',
    });
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') return route.continue();
    const method = req.method();
    const path = url.pathname;
    if (method === 'GET' && path === '/api/servers') return route.fulfill({ json: [state.server] });
    if (method === 'POST' && path === '/api/servers') {
      mutations.push(req);
      if (state.fail) return route.fulfill({ status: 409, json: { error: 'fixture failure' } });
      return route.fulfill({ json: { ...state.server, ...req.postDataJSON(), state: 'ready' } });
    }
    const lifecycle = path.match(/^\/api\/servers\/fixture-server\/(start|stop|restart)$/);
    if (method === 'POST' && lifecycle) {
      mutations.push(req);
      if (state.fail) return route.fulfill({ status: 500, json: { error: 'fixture failure' } });
      state.server.state = lifecycle[1] === 'stop' ? 'stopped' : 'ready';
      return route.fulfill({ json: state.server });
    }
    if (method === 'POST' && path === '/api/clients/fixture-agent/connect') {
      mutations.push(req);
      return route.fulfill({ json: { ok: !state.fail, target: target.id, command: 'fixture private command', output: 'fixture private output', ...(state.fail ? { error: 'fixture failure' } : {}) } });
    }
    if ((method === 'GET' || (method === 'POST' && path === '/api/update/check')) && Object.hasOwn(fixtures, path)) {
      return route.fulfill({ json: fixtures[path] });
    }
    // These optional local views degrade gracefully; do not let them reach a daemon.
    if (method === 'GET' && ['/api/insights', '/api/ambient', '/api/update/result'].includes(path)) {
      return route.fulfill({ status: 503, json: { error: 'not in fixture' } });
    }
    unexpected.push(`${method} ${path}`);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', (error) => errors.push(String(error)));
  const response = await page.goto(`${origin}${opts.frame ? '/test-embedded' : '/?fixture=private-query#private-fragment'}`);
  assert.equal(response.status(), 200);
  return { ctx, page, reports, errors, state, mutations, unexpected,
    async close() { assert.deepEqual(unexpected, []); assert.deepEqual(errors, []); await ctx.close(); },
  };
}

const nav = (p, name) => p.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name, exact: true });
const toggle = (p) => p.getByRole('switch', { name: 'Share usage reports' });
async function go(p, name) {
  await nav(p, name).click();
  assert.equal(await nav(p, name).getAttribute('aria-current'), 'page');
}
const local = (p) => p.evaluate(([choice, id]) => [localStorage.getItem(choice), localStorage.getItem(id)], [choiceKey, idKey]);

async function count(rows, expected) {
  for (let n = 0; rows.length < expected && n < 40; n++) await wait(50);
  await wait(300);
  assert.equal(rows.length, expected, rows.map((r) => `${r.method()} ${r.url()} ${r.postData()}`).join('\n'));
}

async function assertEvents(reports, expected, distinctId) {
  assert.match(distinctId, uuidV4);
  assert.equal(reports.length, expected.length);
  for (const [i, [event, value]] of expected.entries()) {
    const req = reports[i];
    assert.equal(req.method(), 'POST');
    assert.equal(req.url(), collector);
    assert.deepEqual(JSON.parse(req.postData()), {
      api_key: 'phc_test140', event: `hypergate_manager_${event}`,
      properties: { distinct_id: distinctId, product: 'hypergate', surface: 'manager', value, $process_person_profile: false, $geoip_disable: true },
    });
    const headers = await req.allHeaders();
    assert.equal(headers['content-type'], 'text/plain;charset=UTF-8');
    assert.equal(headers.referer, undefined);
    assert.equal(headers.cookie, undefined);
  }
}

async function verify(browser) {
  const h = await harness(browser, configured);
  const { page, ctx, reports, mutations, state } = h;
  await page.getByRole('switch', { name: `Start ${serverName}` }).click();
  await page.getByRole('switch', { name: `Stop ${serverName}` }).waitFor();
  await go(page, 'Settings');
  assert.equal(await toggle(page).getAttribute('aria-checked'), 'false');
  assert(await toggle(page).isEnabled());
  assert.deepEqual(await local(page), [null, null]);
  await count(reports, 0);
  await toggle(page).focus();
  await page.keyboard.press('Space');
  assert.equal(await toggle(page).getAttribute('aria-checked'), 'true');
  const [choice, id] = await local(page);
  assert.equal(choice, 'granted');
  const first = [['manager_opened', 'manager'], ['view_opened', 'settings']];
  await count(reports, first.length);
  await nav(page, 'Settings').click();
  await count(reports, first.length);
  for (const [name, value] of [['People', 'people'], ['Analytics', 'analytics'], ['Servers', 'servers']]) {
    await go(page, name);
    first.push(['view_opened', value]);
    await count(reports, first.length);
  }

  state.fail = true;
  const restart = page.getByRole('button', { name: `Restart ${serverName}` });
  await restart.click();
  await page.getByText(`Could not restart ${serverName}`).waitFor();
  await count(reports, first.length);
  state.fail = false;
  await restart.click();
  first.push(['feature_used', 'server_restarted']);
  await count(reports, first.length);
  for (const [action, value] of [['Stop', 'server_stopped'], ['Start', 'server_started']]) {
    await page.getByRole('switch', { name: `${action} ${serverName}` }).click();
    first.push(['feature_used', value]);
    await count(reports, first.length);
  }

  await page.getByRole('button', { name: 'Add a server', exact: true }).click();
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Fixture private added server');
  await page.getByLabel('Command', { exact: true }).fill('fixture-private-binary');
  await page.getByLabel('Arguments', { exact: true }).fill('--fixture-private-argument');
  const add = page.getByRole('button', { name: 'Add & start' });
  state.fail = true;
  await add.click();
  await page.getByText('A server with that id already exists.').waitFor();
  await count(reports, first.length);
  state.fail = false;
  await add.click();
  await page.getByText('Added Fixture private added server — starting…', { exact: true }).waitFor();
  first.push(['feature_used', 'server_added']);
  await count(reports, first.length);

  await page.getByRole('button', { name: `Show details for ${fixtureAgent.name}`, exact: true }).click();
  await page.getByRole('button', { name: `Connect ${fixtureAgent.name} Client setup and connection instructions`, exact: true }).click();
  const connect = page.getByRole('button', { name: 'Connect Fixture CLI', exact: true });
  state.fail = true;
  await connect.click();
  await page.getByText('fixture failure', { exact: true }).waitFor();
  await count(reports, first.length);
  state.fail = false;
  await connect.click();
  first.push(['feature_used', 'agent_connected']);
  await count(reports, first.length);
  await assertEvents(reports, first, id);
  assert.deepEqual(await ctx.cookies(), []);
  assert.equal(mutations.length, 9);

  await page.reload();
  const reload = [['manager_opened', 'manager'], ['view_opened', 'servers']];
  await count(reports, first.length + reload.length);
  assert.deepEqual(await local(page), ['granted', id]);
  await go(page, 'Settings');
  reload.push(['view_opened', 'settings']);
  await count(reports, first.length + reload.length);
  await assertEvents(reports.slice(first.length), reload, id);
  assert.equal(await toggle(page).getAttribute('aria-checked'), 'true');
  await toggle(page).click();
  assert.deepEqual(await local(page), ['denied', null]);
  await page.reload();
  await page.getByRole('button', { name: `Restart ${serverName}` }).click();
  await page.getByText(`Restarted ${serverName}`, { exact: true }).waitFor();
  await go(page, 'Settings');
  assert.equal(await toggle(page).getAttribute('aria-checked'), 'false');
  await count(reports, first.length + reload.length);
  // A new grant rotates the ID. A failed collector fetch must not disable the product.
  state.collectorOffline = true;
  await toggle(page).click();
  const [regranted, newId] = await local(page);
  assert.equal(regranted, 'granted');
  assert.notEqual(newId, id);
  // The manager was reloaded while opted out, so this is its first reportable open.
  const retryGrant = [['manager_opened', 'manager'], ['view_opened', 'settings']];
  await count(reports, first.length + reload.length + retryGrant.length);
  await assertEvents(reports.slice(first.length + reload.length), retryGrant, newId);
  await h.close();
  console.log('Manager: default-off, keyboard opt-in, all four views, success-only lifecycle/add/connect, exact payloads, persistence, withdrawal, ID rotation and collector failure pass.');

  const seeded = { [choiceKey]: 'granted', [idKey]: fixtureId };
  for (const scenario of [
    { origin: unconfigured }, { origin: unconfigured, seeded },
    { origin: configured, signal: 'globalPrivacyControl', seeded }, { origin: configured, signal: 'doNotTrack', seeded },
    { origin: configured, shell: false, seeded }, { origin: configured, frame: true, seeded },
  ]) {
    const check = await harness(browser, scenario.origin, scenario);
    const view = scenario.frame ? check.page.frameLocator('iframe') : check.page;
    await go(view, 'Settings');
    if (scenario.shell === false || scenario.frame) assert.equal(await toggle(view).count(), 0);
    else {
      assert.equal(await toggle(view).getAttribute('aria-checked'), 'false');
      assert(await toggle(view).isDisabled());
      await view.getByText(scenario.signal ? /Nothing is sent while Do Not Track/ : /Usage reporting is not available in this build/).waitFor();
    }
    await go(view, 'Servers');
    await view.getByRole('switch', { name: `Start ${serverName}` }).click();
    await view.getByRole('switch', { name: `Stop ${serverName}` }).waitFor();
    await count(check.reports, 0);
    if (!scenario.frame) assert.deepEqual(await local(check.page), scenario.signal ? ['denied', null] : scenario.seeded ? ['granted', fixtureId] : [null, null]);
    await check.close();
  }
  console.log('Manager: empty config (including stored grant), both privacy signals, unmarked browser/guest and marked iframe remain silent.');
}

async function capture(browser, dest) {
  await mkdir(dest, { recursive: true });
  for (const [size, viewport, scale] of [['desktop', { width: 1200, height: 820 }, 2], ['mobile', { width: 420, height: 844 }, 1]]) {
    for (const theme of ['dark', 'light']) {
      for (const [phase, origin] of [['before', base], ['after', configured]]) {
        const h = await harness(browser, origin, { viewport, scale, theme });
        if (phase === 'before' && size === 'mobile') {
          // On the baseline, the narrow icon-only rail does not name its buttons.
          await h.page.locator('nav[aria-label="Primary navigation"] > .nav-group > button').nth(3).click();
        } else await go(h.page, 'Settings');
        await h.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
        await h.page.getByRole('switch', { name: 'Run on startup' }).waitFor();
        await h.page.evaluate(() => document.fonts.ready);
        if (phase === 'after') assert.equal(await toggle(h.page).getAttribute('aria-checked'), 'false');
        else assert.equal(await toggle(h.page).count(), 0);
        await count(h.reports, 0);
        await h.page.screenshot({ path: resolve(dest, `manager-${phase}-${size}-${theme}.png`) });
        if (phase === 'after' && size === 'desktop' && theme === 'dark') {
          await toggle(h.page).click();
          await count(h.reports, 2);
          await assertEvents(h.reports, [['manager_opened', 'manager'], ['view_opened', 'settings']], (await local(h.page))[1]);
          await h.page.mouse.move(1, 1);
          await h.page.screenshot({ path: resolve(dest, 'manager-after-desktop-dark-enabled.png') });
        }
        await h.close();
      }
    }
  }
  if (process.env.MANAGER_VIDEO_FRAMES_DIR) {
    const dir = process.env.MANAGER_VIDEO_FRAMES_DIR;
    await mkdir(dir, { recursive: true });
    const h = await harness(browser, configured, { motion: true, viewport: { width: 900, height: 620 } });
    await go(h.page, 'Settings');
    await h.page.getByRole('switch', { name: 'Run on startup' }).waitFor();
    await h.page.evaluate(() => document.fonts.ready);
    const shot = (i) => h.page.screenshot({ path: resolve(dir, `${String(i).padStart(2, '0')}.png`) });
    for (let i = 0; i < 28; i++) {
      if (i === 5 || i === 16) await toggle(h.page).evaluate((el) => el.click());
      await shot(i);
    }
    await count(h.reports, 2);
    assert.deepEqual(await local(h.page), ['denied', null]);
    await h.close();
  }
}

const browser = await chromium.launch({ args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
try {
  await verify(browser);
  if (process.env.MANAGER_EVIDENCE_DIR) await capture(browser, process.env.MANAGER_EVIDENCE_DIR);
} finally {
  await browser.close();
}
