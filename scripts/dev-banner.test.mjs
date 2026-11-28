// `node --test scripts/dev-banner.test.mjs` (part of `npm test`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ART, devBanner, staleBuildHint } from './dev-banner.mjs';

const info = {
  version: '1.32.0',
  manager: 'http://localhost:5180/',
  gateway: 'http://localhost:7777/mcp',
  dataDir: '/home/me/.hypergate',
};

test('the art is six rows of one width, the gate beside the word', () => {
  assert.equal(ART.length, 6);
  assert.equal(new Set(ART.map((l) => l.length)).size, 1);
  assert.match(ART[0], /\.-""-\./);
});

test('says what runs where, and which data dir it uses', () => {
  const text = devBanner({ ...info, keys: true });
  assert.match(text, /Hypergate 1\.32\.0 dev is running/);
  assert.match(text, /Manager\s+http:\/\/localhost:5180\//);
  assert.match(text, /Gateway\s+http:\/\/localhost:7777\/mcp/);
  assert.match(text, /\/home\/me\/\.hypergate \(your real data; HYPERGATE_DIR=<dir> for a scratch copy\)/);
  assert.match(devBanner({ ...info, scratch: true }), /\(scratch\)/);
});

test('lists the keys only where there is a keyboard to press them', () => {
  const withKeys = devBanner({ ...info, keys: true });
  for (const key of [/q or Enter\s+stop/, /Ctrl\+C\s+same; press again to force/, /r\s+restart with what is on disk/, /o\s+open the manager/]) {
    assert.match(withKeys, key);
  }
  // r needs scripts/dev.mjs to start the next launcher; run directly, it is not offered.
  assert.doesNotMatch(devBanner({ ...info, keys: true, restart: false }), /restart with what is on disk/);
  const without = devBanner({ ...info, keys: false });
  assert.doesNotMatch(without, /q or Enter/);
  assert.match(without, /Ctrl\+C stops it/);
});

test('says when the manager is in the desktop app, and that o is the browser then', () => {
  const app = devBanner({ ...info, keys: true, desktop: true });
  assert.match(app, /Desktop\s+the manager in the app's own window \(npm run dev:browser for a tab instead\)/);
  assert.match(app, /o\s+open the manager in your browser/);
  const tab = devBanner({ ...info, keys: true });
  assert.doesNotMatch(tab, /Desktop/);
  assert.doesNotMatch(tab, /in your browser/);
});

test('colour only when asked: escapes in a terminal, plain text otherwise', () => {
  assert.doesNotMatch(devBanner(info), /\x1b\[/);
  // The gate's violet-to-cyan gradient, one truecolour escape per character.
  const colored = devBanner({ ...info, color: true });
  assert.match(colored, /\x1b\[38;2;12\d;1\d\d;25\dm/);
  assert.match(colored, /\x1b\[38;2;3\d;21\d;23\dm/);
});

test('recognises the daemon loading a stale shared build', () => {
  const line = "SyntaxError: The requested module '@hypergate/core' does not provide an export named 'credentialEnv'";
  assert.match(staleBuildHint(line) ?? '', /older build of @hypergate\/core/);
  assert.equal(staleBuildHint('hypergated up'), undefined);
});
