// Run against three isolated production previews: clean base, configured test, and unconfigured.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:4540';
const after = 'http://127.0.0.1:4521';
const off = 'http://127.0.0.1:4522';
const evidence = process.env.SITE_EVIDENCE_DIR;
const collector = 'https://us.i.posthog.com/i/v0/e/';
const testKey = 'phc_test140';
const consentKey = 'hypergate.analytics.site.v1.choice';
const idKey = 'hypergate.analytics.site.v1.id';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repo = 'https://github.com/nekko-labs/hypergate';
const tag = 'v1.34.0';
const portableZipName = 'hypergate-1.34.0-portable.zip';
const portableZipUrl = `${repo}/releases/download/${tag}/${portableZipName}`;
const names = [
  'hypergate-1.34.0-macos-arm64.dmg', 'hypergate-macos-apple-silicon.dmg',
  'hypergate-1.34.0-windows-x64-setup.exe', 'hypergate-1.34.0-linux-x64.deb',
  'hypergate-1.34.0-linux-x64.tar.gz', portableZipName, 'SHA256SUMS',
];
const release = {
  tag_name: tag, name: 'Midnight icons', published_at: '2026-11-24T12:00:00Z',
  html_url: `${repo}/releases/tag/${tag}`, draft: false, prerelease: false,
  body: `A consistent Midnight tile for the Hypergate app and the gateway.\n\n### Features\n\n- Updated desktop and connection icons.\n- [Mac installer](${repo}/releases/latest/download/hypergate-macos-apple-silicon.dmg).\n- [Portable ZIP](${portableZipUrl}).`,
  assets: names.map((name) => ({ name, browser_download_url: `${repo}/releases/download/${tag}/${name}`, size: 200 })),
};
const modes = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
};
const mac = { platform: 'macOS', architecture: 'arm', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
const linux = { platform: 'Linux', architecture: 'x86', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' };
const intel = { ...mac, architecture: 'x86' };

async function context(browser, mode, opts = {}) {
  const device = opts.device || mac;
  const ctx = await browser.newContext({
    ...modes[mode],
    ...(mode === 'desktop' ? { userAgent: device.userAgent } : {}),
    reducedMotion: opts.video ? 'no-preference' : 'reduce', acceptDownloads: true,
    colorScheme: 'dark', serviceWorkers: 'block',
    ...(opts.video ? { recordVideo: { dir: opts.video, size: modes[mode].viewport } } : {}),
  });
  if (mode === 'desktop') {
    await ctx.addInitScript(({ platform, architecture }) => {
      Object.defineProperty(navigator, 'platform', { get: () => platform });
      Object.defineProperty(navigator, 'userAgentData', { get: () => ({
        platform, mobile: false, getHighEntropyValues: async () => ({ architecture }),
      }) });
    }, device);
  }
  if (opts.signal) await ctx.addInitScript((signal) => {
    Object.defineProperty(navigator, signal, { value: signal === 'globalPrivacyControl' ? true : '1' });
  }, opts.signal);
  const requests = [], destinations = [], unexpected = [];
  // Only loopback escapes the route. Even an unexpected collector URL is aborted.
  ctx.on('request', (req) => {
    if (new URL(req.url()).hostname.endsWith('.posthog.com')) requests.push(req);
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if ([base, after, off].includes(url.origin)) return route.continue();
    if (url.href === collector && req.method() === 'POST') {
      return route.fulfill({ status: 200, json: { status: 1 }, headers });
    }
    if (url.origin === 'https://api.github.com' && url.pathname.startsWith('/repos/nekko-labs/hypergate/releases')) {
      if (opts.failReleases) return route.fulfill({ status: 503, headers });
      return route.fulfill({ json: url.pathname.endsWith('/latest') ? release : [release], headers });
    }
    if (url.origin === 'https://github.com') {
      destinations.push(url.href);
      return route.fulfill({ status: 200, body: 'Intercepted destination', headers: { 'content-disposition': 'attachment; filename=fixture.txt' } });
    }
    unexpected.push(url.origin);
    return route.abort();
  });
  return { ctx, requests, destinations, unexpected };
}

async function visit(page, origin, path) {
  const result = await page.goto(`${origin}${path}`);
  assert.equal(result.status(), 200);
  await page.evaluate(() => document.fonts.ready);
  if (path === '/' || path.startsWith('/?') || path.startsWith('/release-notes.html')) {
    await page.locator('[data-download-primary]').first().filter({ hasText: 'Download for Mac (Apple silicon)' })
      .waitFor({ state: 'attached', timeout: 700 }).catch(() => {});
  }
}

const bubble = (p) => p.getByRole('region', { name: 'Allow website analytics?' });
const dialog = (p) => p.getByRole('dialog', { name: 'Privacy choices' });
const manage = (p) => p.getByRole('button', { name: 'Privacy choices' });
const local = (p) => p.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
const bannerAction = (p, label) => bubble(p).getByRole('button', { name: label });
async function assertEvent(req, event, value, distinctId) {
  assert.match(distinctId, uuidV4);
  assert.equal(req.url(), collector);
  assert.equal(req.method(), 'POST');
  assert.deepEqual(JSON.parse(req.postData()), {
    api_key: testKey,
    event: `hypergate_site_${event}`,
    properties: {
      distinct_id: distinctId, product: 'hypergate', surface: 'site', value,
      $process_person_profile: false, $geoip_disable: true,
    },
  });
  const headers = await req.allHeaders();
  assert.equal(headers['content-type'], 'text/plain;charset=UTF-8');
  assert.equal(headers.referer, undefined);
  assert.equal(headers.cookie, undefined);
}

async function count(requests, quantity) {
  for (let tries = 0; tries < 25 && requests.length < quantity; tries++) await wait(80);
  // Wait for duplicate or forbidden requests too, not just the expected positive case.
  await wait(300);
  assert.equal(requests.length, quantity, JSON.stringify(requests.map((req) => req.postData())));
}

async function countDestinations(destinations, quantity) {
  for (let tries = 0; tries < 25 && destinations.length < quantity; tries++) await wait(80);
  assert.equal(destinations.length, quantity, destinations.join('\n'));
}

async function verify(browser) {
  const { ctx, requests, destinations, unexpected } = await context(browser, 'desktop');
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await visit(page, after, '/?email=private-url-value#private-fragment');
  await bubble(page).waitFor();
  assert.deepEqual(await local(page), {});
  assert.deepEqual(await ctx.cookies(), []);
  await count(requests, 0);
  const style = async (label) => bannerAction(page, label).evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.width, s.height, s.font, s.backgroundColor, s.color, s.borderColor];
  });
  assert.deepEqual(await style('Decline analytics'), await style('Allow analytics'));
  await bannerAction(page, 'Decline analytics').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'MAIN');
  assert(!await bubble(page).isVisible());
  const denied = await local(page);
  assert.deepEqual(denied, { [consentKey]: 'denied' });
  await page.locator('a[data-download-primary]').first().click({ noWaitAfter: true });
  await countDestinations(destinations, 1);
  await count(requests, 0);
  await page.reload();
  assert(!await bubble(page).isVisible());
  await manage(page).click();
  assert.match(await dialog(page).innerText(), /Website analytics is off/);
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Close');
  await page.keyboard.press('Escape');
  assert(await manage(page).evaluate((el) => el === document.activeElement));
  await manage(page).click();
  await dialog(page).getByRole('button', { name: 'Allow analytics' }).click();
  await count(requests, 1);
  assert.deepEqual(await ctx.cookies(), []);
  const accepted = await local(page);
  assert.equal(Object.keys(accepted).length, 2);
  assert.equal(accepted[consentKey], 'granted');
  assert.match(accepted[idKey], uuidV4);
  await page.locator('a[data-download-primary]').first().focus();
  await page.keyboard.press('Enter');
  await count(requests, 2);
  await countDestinations(destinations, 2);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true }));
  await page.getByRole('button', { name: 'Copy install command' }).click();
  assert.equal(await page.getByRole('button', { name: 'Copy install command' }).innerText(), 'Copy failed');
  await count(requests, 2);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.testClipboard = text; } }, configurable: true }));
  await page.getByRole('button', { name: 'Copy install command' }).click();
  await count(requests, 3);
  assert.match(await page.evaluate(() => window.testClipboard), /curl .*hypergate.*dmg/);
  assert.equal(await page.getByRole('button', { name: 'Copy install command' }).innerText(), 'Copied');

  await page.getByRole('link', { name: 'Release notes', exact: true }).last().click();
  await page.locator('.release-highlights .highlight-release').first().waitFor();
  await count(requests, 4);
  const releaseHeading = page.locator('#release-list').getByRole('heading', { name: 'Midnight icons' });
  assert.equal(await releaseHeading.count(), 0, 'the archive has not loaded yet');
  const highlightLink = page.locator('.release-highlights a[href*="/releases/tag/"]').first();
  const beforeHighlightClick = destinations.length;
  await highlightLink.click();
  await countDestinations(destinations, beforeHighlightClick + 1);
  await page.getByText('Show recent releases', { exact: true }).click();
  await releaseHeading.waitFor();
  await count(requests, 4);
  await page.locator('.release-assets a').filter({ hasText: 'windows-x64-setup.exe' }).click({ button: 'middle' });
  await count(requests, 5);
  const portableZip = page.locator('.release-body').getByRole('link', { name: 'Portable ZIP', exact: true });
  assert.equal(await portableZip.getAttribute('href'), portableZipUrl);
  const previousDestinations = destinations.length;
  await portableZip.click({ button: 'middle' });
  await countDestinations(destinations, previousDestinations + 1);
  assert.equal(destinations[previousDestinations], portableZipUrl);
  await count(requests, 6);
  await page.getByRole('link', { name: 'Full release on GitHub' }).click();
  await count(requests, 6);
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await page.getByRole('heading', { name: 'Privacy policy' }).waitFor();
  await count(requests, 7);
  await page.getByRole('link', { name: 'Terms', exact: true }).click();
  await page.getByRole('heading', { name: 'Terms', exact: true }).waitFor();
  await count(requests, 8);
  await manage(page).click();
  await dialog(page).getByRole('button', { name: 'Turn analytics off' }).click();
  assert.deepEqual(await local(page), denied);
  await visit(page, after, '/');
  await page.locator('a[data-download-primary]').first().click({ noWaitAfter: true });
  await count(requests, 8);

  for (const [i, [event, value]] of [
    ['page_view', 'home'], ['download_clicked', 'macos'], ['install_command_copied', 'shell'],
    ['page_view', 'releases'], ['download_clicked', 'windows'], ['download_clicked', 'other'],
    ['page_view', 'privacy'], ['page_view', 'terms'],
  ].entries()) await assertEvent(requests[i], event, value, accepted[idKey]);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await ctx.close();
  console.log('Desktop: first visit, decline, persistence, keyboard focus, allow, page labels, Mac intent, middle-click Windows and portable ZIP intent, failed/successful clipboard, legal navigation and withdrawal pass.');

  for (const scenario of [{ origin: off }, { origin: after, signal: 'globalPrivacyControl' }, { origin: after, signal: 'doNotTrack' }]) {
    const disabled = await context(browser, 'desktop', scenario);
    const noAnalytics = await disabled.ctx.newPage();
    await visit(noAnalytics, scenario.origin, '/');
    await noAnalytics.locator('a[data-download-primary]').first().click({ noWaitAfter: true });
    await countDestinations(disabled.destinations, 1);
    await manage(noAnalytics).click();
    assert(!await bubble(noAnalytics).isVisible());
    assert.match(await dialog(noAnalytics).innerText(), /unavailable here/);
    assert.equal(await dialog(noAnalytics).getByRole('button', { name: 'Allow analytics' }).count(), 0);
    assert.deepEqual(await local(noAnalytics), {});
    assert.deepEqual(await disabled.ctx.cookies(), []);
    await count(disabled.requests, 0);
    assert.deepEqual(disabled.unexpected, []);
    await disabled.ctx.close();
  }
  console.log('Unconfigured, Global Privacy Control and Do Not Track: no prompt, storage or traffic; installer and privacy details remain usable.');

  for (const opts of [{ device: linux }, { device: intel, failReleases: true }]) {
    const check = await context(browser, 'desktop', opts);
    const p = await check.ctx.newPage();
    p.setDefaultTimeout(5000);
    await p.goto(`${after}/`);
    await bannerAction(p, 'Allow analytics').click();
    await count(check.requests, 1);
    const id = (await local(p))[idKey];
    await assertEvent(check.requests[0], 'page_view', 'home', id);
    if (opts.device === linux) {
      const picker = p.locator('.hero [data-linux-picker]');
      await picker.locator('summary').click();
      const disabledRpm = picker.locator('[data-linux-format="rpm"]');
      assert.equal(await disabledRpm.getAttribute('href'), null);
      assert.equal(await disabledRpm.getAttribute('aria-disabled'), 'true');
      await disabledRpm.click({ force: true });
      assert.deepEqual(check.destinations, []);
      await count(check.requests, 1);
      await picker.locator('[data-linux-format="tar.gz"]').click();
      await count(check.requests, 2);
      await assertEvent(check.requests[1], 'download_clicked', 'linux', id);
      assert(check.destinations.some((href) => href.endsWith('.tar.gz')));
    } else {
      await p.getByText('Needs an Apple silicon Mac').first().click();
      await countDestinations(check.destinations, 1);
      assert.equal(check.destinations[0], `${repo}/releases/latest`);
      await count(check.requests, 1);
    }
    assert.deepEqual(check.unexpected, []);
    await check.ctx.close();
  }
  const mobile = await context(browser, 'mobile');
  const phone = await mobile.ctx.newPage();
  await visit(phone, after, '/');
  assert(!await phone.locator('[data-download-primary]').first().isVisible());
  await bannerAction(phone, 'Decline analytics').tap();
  assert(!await bubble(phone).isVisible());
  await manage(phone).tap();
  await dialog(phone).getByRole('button', { name: 'Allow analytics' }).tap();
  await count(mobile.requests, 1);
  await assertEvent(mobile.requests[0], 'page_view', 'home', (await local(phone))[idKey]);
  assert.deepEqual(mobile.unexpected, []);
  await mobile.ctx.close();
  console.log('Linux picker, disabled RPM, Intel release fallback, and mobile touch choices pass.');

  const failure = await context(browser, 'desktop', { failReleases: true });
  const fallbackPage = await failure.ctx.newPage();
  await visit(fallbackPage, after, '/release-notes.html');
  await fallbackPage.getByText('Show recent releases', { exact: true }).click();
  await fallbackPage.getByText('Release notes could not be loaded right now.').waitFor();
  assert(await fallbackPage.locator('.release-highlights .highlight-release').first().isVisible());
  await fallbackPage.getByRole('link', { name: 'View releases on GitHub' }).waitFor();
  assert.deepEqual(failure.unexpected, []);
  await count(failure.requests, 0);
  await failure.ctx.close();

  const noScript = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
  await noScript.route('**/*', (route) => new URL(route.request().url()).origin === after ? route.continue() : route.abort());
  const staticPage = await noScript.newPage();
  await staticPage.goto(`${after}/release-notes.html`);
  assert(await staticPage.locator('.release-highlights .highlight-release').first().isVisible());
  assert(await staticPage.getByRole('link', { name: 'Privacy', exact: true }).isVisible());
  assert(await staticPage.getByRole('link', { name: 'Terms', exact: true }).isVisible());
  assert(!await bubble(staticPage).isVisible());
  await noScript.close();
  console.log('Release highlights and legal navigation survive GitHub failure and disabled JavaScript.');
}

async function capture(browser) {
  await mkdir(evidence, { recursive: true });
  for (const mode of Object.keys(modes)) {
    for (const [name, url] of [['before', base], ['after', after]]) {
      if (process.env.SITE_CAPTURE_PHASE && process.env.SITE_CAPTURE_PHASE !== name) continue;
      for (const [route, path] of [['home', '/'], ['releases', '/release-notes.html'], ['privacy', '/privacy/'], ['terms', '/terms/']]) {
        if (name === 'before' && ['privacy', 'terms'].includes(route)) continue;
        const { ctx, requests, unexpected } = await context(browser, mode);
        const page = await ctx.newPage();
        await visit(page, url, path);
        if (name === 'after') await bubble(page).waitFor();
        const save = (surface) => page.screenshot({ path: resolve(evidence, `${name}-${surface}-${mode}.png`) });
        await save(route);
        if (name === 'after') {
          await bannerAction(page, 'Decline analytics').click();
          if (route === 'privacy' || route === 'terms') {
            await page.screenshot({ path: resolve(evidence, `after-${route}-full-${mode}.png`), fullPage: true });
          }
        }
        if (route === 'home' || route === 'releases') {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(400);
          await save(`${route}-footer`);
          if (name === 'after' && route === 'home') {
            await manage(page).click();
            await save('settings');
          }
        }
        await count(requests, 0);
        assert.deepEqual(unexpected, []);
        await ctx.close();
      }
    }
  }
  if (process.env.SITE_VIDEO_TMP) {
    for (const mode of Object.keys(modes)) {
      const { ctx, requests, unexpected } = await context(browser, mode, { video: process.env.SITE_VIDEO_TMP });
      const page = await ctx.newPage();
      await visit(page, after, '/');
      await page.waitForTimeout(850);
      assert.deepEqual(requests, []);
      await bannerAction(page, 'Allow analytics').click();
      const id = (await local(page))[idKey];
      if (mode === 'desktop') {
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } }));
        await page.getByRole('button', { name: 'Copy install command' }).click();
        await page.waitForTimeout(1450);
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await manage(page).click();
      await page.waitForTimeout(950);
      await dialog(page).getByRole('button', { name: 'Turn analytics off' }).click();
      await page.waitForTimeout(500);
      await manage(page).click();
      await page.waitForTimeout(950);
      await page.keyboard.press('Escape');
      await count(requests, mode === 'desktop' ? 2 : 1);
      await assertEvent(requests[0], 'page_view', 'home', id);
      if (mode === 'desktop') await assertEvent(requests[1], 'install_command_copied', 'shell', id);
      assert.deepEqual(await local(page), { [consentKey]: 'denied' });
      assert.deepEqual(unexpected, []);
      const video = page.video();
      await ctx.close();
      await video.saveAs(resolve(evidence, `consent-flow-${mode}.webm`));
    }
  }
}

const browser = await chromium.launch({ args: [
  '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] });
try {
  if (!process.env.SITE_VISUAL_ONLY) await verify(browser);
  if (evidence) await capture(browser);
} finally {
  await browser.close();
}
