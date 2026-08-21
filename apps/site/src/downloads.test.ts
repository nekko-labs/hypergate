import assert from 'node:assert/strict';
import test from 'node:test';
import { findInstaller, installerUrlFor, installCommandFor } from './downloads.ts';

const macRelease = {
  tag_name: 'v1.9.0',
  html_url: 'https://github.com/nekko-labs/hypergate/releases/tag/v1.9.0',
  assets: [
    { name: 'hypergate-1.9.0-macos-arm64.dmg', browser_download_url: 'https://example.test/versioned.dmg' },
    { name: 'hypergate-macos-apple-silicon.dmg', browser_download_url: 'https://example.test/alias.dmg' },
  ],
};

test('keeps a direct Windows installer fallback before release metadata loads', () => {
  assert.equal(
    installerUrlFor({ platform: 'windows', architecture: 'x64' }),
    'https://github.com/nekko-labs/hypergate/releases/latest/download/hypergate-windows-x64-setup.exe',
  );
});

test('builds a PowerShell install and launch command for Windows', () => {
  const install = installCommandFor({ platform: 'windows', architecture: 'arm64' });
  assert.equal(install?.shell, 'PowerShell');
  assert.match(install?.command ?? '', /hypergate-windows-arm64-setup\.exe/);
  assert.match(install?.command ?? '', /Start-Process .* -Wait/);
  assert.match(install?.command ?? '', /hypergate\.exe" app$/);
});

test('builds a macOS disk image download and open command', () => {
  const install = installCommandFor({ platform: 'macos', architecture: 'arm64' });
  assert.equal(install?.shell, 'Terminal');
  assert.match(install?.command ?? '', /hypergate-macos-apple-silicon\.dmg/);
  assert.doesNotMatch(install?.command ?? '', /sudo/);
  assert.match(install?.command ?? '', /open .*hypergate\.dmg$/);
});

test('builds a Debian package install and launch command for Linux', () => {
  const install = installCommandFor({ platform: 'linux', architecture: 'arm64' });
  assert.equal(install?.shell, 'Bash · Debian / Ubuntu');
  assert.match(install?.command ?? '', /hypergate-linux-arm64\.deb/);
  assert.match(install?.command ?? '', /sudo apt-get install/);
  assert.match(install?.command ?? '', /hypergate app$/);
});

test('names the Mac download the way a Mac owner reads it', () => {
  assert.equal(
    installerUrlFor({ platform: 'macos', architecture: 'arm64' }),
    'https://github.com/nekko-labs/hypergate/releases/latest/download/hypergate-macos-apple-silicon.dmg',
  );
});

test('prefers the Apple silicon alias over the versioned disk image', () => {
  const asset = findInstaller(macRelease, { platform: 'macos', architecture: 'arm64' });
  assert.equal(asset?.name, 'hypergate-macos-apple-silicon.dmg');
});

test('falls back to the versioned disk image on a release without the alias', () => {
  const older = { ...macRelease, assets: [macRelease.assets[0]] };
  const asset = findInstaller(older, { platform: 'macos', architecture: 'arm64' });
  assert.equal(asset?.name, 'hypergate-1.9.0-macos-arm64.dmg');
});

test('offers nothing to an Intel Mac, which cannot run the Apple silicon build', () => {
  assert.equal(installerUrlFor({ platform: 'macos', architecture: 'x64' }), null);
  assert.equal(installCommandFor({ platform: 'macos', architecture: 'x64' }), null);
  assert.equal(findInstaller(macRelease, { platform: 'macos', architecture: 'x64' }), undefined);
});

test('does not offer a terminal command on unsupported devices', () => {
  assert.equal(installCommandFor({ platform: 'mobile', architecture: 'arm64' }), null);
  assert.equal(installCommandFor({ platform: 'unknown', architecture: 'x64' }), null);
});
