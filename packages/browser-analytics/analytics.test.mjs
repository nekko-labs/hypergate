import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from './build-config.ts';
import { createAnalytics } from './index.ts';

test('no production site token on a preview; explicit blank overrides disable release defaults', () => {
  globalThis.location = { origin: 'https://preview.example' };
  assert.deepEqual(buildConfig('site', { PROD: true }), {});
  assert.deepEqual(buildConfig('manager', { PROD: false }), {});
  globalThis.location.origin = 'https://hypergate.app';
  assert.equal(buildConfig('site', { PROD: true }).host, 'https://us.i.posthog.com');
  assert.equal(buildConfig('manager', { PROD: true, VITE_HYPERGATE_POSTHOG_KEY: '' }).host, undefined);
});

test('only known labels under current consent leave the device; withdrawal rotates identity', () => {
  const values = new Map();
  globalThis.window = { crypto, localStorage: { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) } };
  const calls = []; globalThis.fetch = async (...args) => { calls.push(args); };
  const config = {key:'phc_test',host:'https://us.i.posthog.com'};
  const a = createAnalytics('site', config);
  const manager = createAnalytics('manager', config);
  a.track('page_view', 'home'); assert.equal(calls.length, 0); assert.equal(values.size, 0);
  a.setConsent('granted'); a.track('page_view', 'private-path'); a.track('toString','home'); manager.track('view_opened','settings');
  assert.equal(calls.length, 0);
  a.track('download_clicked','other'); assert.equal(calls.length,1);
  const [url, options] = calls[0]; const event = JSON.parse(options.body);
  assert.equal(url, `${config.host}/i/v0/e/`); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.credentials,'omit');
  assert.equal(event.event, 'hypergate_site_download_clicked'); assert.equal(event.properties.value, 'other');
  assert.equal(event.properties.$process_person_profile,false); assert.equal(event.properties.$geoip_disable,true);
  a.setConsent('denied'); a.track('page_view','home'); assert.equal(calls.length,1); assert.equal(values.size,1);
  a.setConsent('granted'); a.track('page_view','home'); assert.notEqual(JSON.parse(calls[1][1].body).properties.distinct_id,event.properties.distinct_id);
});
