import assert from 'node:assert/strict';
import test from 'node:test';
import { installerPlatform } from './installer-intent.ts';

const releases = 'https://github.com/nekko-labs/hypergate/releases';

test('recognizes direct release assets without reporting any URL components', () => {
  assert.equal(installerPlatform(`${releases}/latest/download/hypergate-macos-apple-silicon.dmg?private=yes#section`), 'macos');
  assert.equal(installerPlatform(`${releases}/download/v1.34.0/hypergate-1.34.0-windows-x64-setup.exe`), 'windows');
  for (const format of ['deb', 'rpm', 'tar.gz']) {
    assert.equal(installerPlatform(`${releases}/download/v1.34.0/hypergate-linux-arm64.${format}`), 'linux');
  }
  assert.equal(installerPlatform(`${releases}/download/v1.34.0/hypergate-shell-linux-arm64-1.34.0.tgz`), 'other');
});

test('ignores GitHub listings, unrelated hosts or repos, and non-installer assets', () => {
  for (const url of [
    `${releases}/latest`, `${releases}/tag/v1.34.0`, '#', '',
    `${releases}/download/v1.34.0/SHA256SUMS`,
    `${releases}/download/v1.34.0/hypergate.dmg.sha256`,
    'https://github.com/another/hypergate/releases/latest/download/hypergate-macos.dmg',
    'https://github.com.example.test/nekko-labs/hypergate/releases/latest/download/hypergate-macos.dmg',
    'javascript:void(0)',
  ]) assert.equal(installerPlatform(url), undefined, url);
});
