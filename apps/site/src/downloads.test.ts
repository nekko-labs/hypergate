import assert from 'node:assert/strict';
import test from 'node:test';
import { installerUrlFor, installCommandFor } from './downloads.ts';

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
  const install = installCommandFor({ platform: 'macos', architecture: 'x64' });
  assert.equal(install?.shell, 'Terminal');
  assert.match(install?.command ?? '', /hypergate-macos-x64\.dmg/);
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

test('does not offer a terminal command on unsupported devices', () => {
  assert.equal(installCommandFor({ platform: 'mobile', architecture: 'arm64' }), null);
  assert.equal(installCommandFor({ platform: 'unknown', architecture: 'x64' }), null);
});
