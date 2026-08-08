import { describe, it, expect } from 'vitest';
import {
  assetsFromGithub,
  assetsFromNpm,
  compareVersions,
  detectInstallChannel,
  isNewerVersion,
  latestFromGithub,
  downloadableUrl,
  latestFromNpm,
  parseSha256Sums,
  releaseUrlFor,
  shellPackageFor,
  updatePlan,
} from './update.js';

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('0.11.0', '0.10.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.11.1', '0.11.2')).toBeLessThan(0);
    expect(compareVersions('0.11.1', '0.11.1')).toBe(0);
  });

  it('tolerates a v prefix and a missing patch', () => {
    expect(compareVersions('v0.12.0', '0.11.1')).toBeGreaterThan(0);
    expect(compareVersions('0.12', '0.12.0')).toBe(0);
  });

  it('ranks a prerelease below its release', () => {
    expect(compareVersions('0.12.0-rc.1', '0.12.0')).toBeLessThan(0);
    expect(compareVersions('0.12.0-rc.2', '0.12.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.12.0-rc.1', '0.12.0-beta.9')).toBeGreaterThan(0);
    // A numeric identifier ranks below an alphanumeric one (semver §11).
    expect(compareVersions('0.12.0-1', '0.12.0-alpha')).toBeLessThan(0);
  });

  it('treats junk as older than anything real, so it can never look like an upgrade', () => {
    expect(compareVersions('not-a-version', '0.11.1')).toBeLessThan(0);
    expect(isNewerVersion('latest', '0.11.1')).toBe(false);
    expect(isNewerVersion(undefined, '0.11.1')).toBe(false);
  });
});

describe('detectInstallChannel', () => {
  it('recognises a repo checkout, even one living under a hypergate folder', () => {
    expect(detectInstallChannel({ daemonPath: 'C:/Users/phili/code/hypergate/apps/daemon/src/index.ts', platform: 'win32' })).toBe('repo');
    expect(detectInstallChannel({ daemonPath: '/home/p/code/hypergate/apps/daemon/dist/index.js', platform: 'linux' })).toBe('repo');
  });

  it('recognises a global npm install', () => {
    expect(
      detectInstallChannel({
        daemonPath: 'C:/Users/phili/AppData/Roaming/npm/node_modules/hypergated/dist/hypergated.mjs',
        platform: 'win32',
      }),
    ).toBe('npm');
    expect(detectInstallChannel({ daemonPath: '/usr/local/lib/node_modules/hypergated/dist/hypergated.mjs', platform: 'linux' })).toBe('npm');
  });

  it('recognises the native installers, per platform', () => {
    expect(
      detectInstallChannel({
        daemonPath: 'C:/Users/phili/AppData/Local/Programs/Hypergate/hypergated.exe',
        platform: 'win32',
      }),
    ).toBe('installer');
    expect(detectInstallChannel({ daemonPath: '/Applications/Hypergate.app/Contents/MacOS/hypergated', platform: 'darwin' })).toBe('installer');
    expect(detectInstallChannel({ daemonPath: '/usr/lib/hypergate/hypergated', platform: 'linux' })).toBe('installer');
  });

  it("says unknown rather than guessing when the path means nothing to us", () => {
    expect(detectInstallChannel({ daemonPath: '/tmp/whatever/hypergated', platform: 'linux' })).toBe('unknown');
  });
});

describe('updatePlan', () => {
  it('offers one-click only on the npm channel, and names the version it installs', () => {
    const plan = updatePlan('npm', '0.12.0', 'win32');
    expect(plan.canApply).toBe(true);
    expect(plan.command).toBe('npm install -g hypergated@0.12.0');
    // With no known version it still gives a runnable command.
    expect(updatePlan('npm', undefined, 'linux').command).toBe('npm install -g hypergated@latest');
  });

  it('refuses to auto-run an unsigned installer, and explains instead', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const plan = updatePlan('installer', '0.12.0', platform);
      expect(plan.canApply, platform).toBe(false);
      expect(plan.note, platform).toBeTruthy();
    }
    // Linux additionally needs root, so the command is the package manager's.
    expect(updatePlan('installer', '0.12.0', 'linux').command).toContain('apt install');
  });

  it('tells a checkout to pull, and an unplaceable install nothing but the truth', () => {
    expect(updatePlan('repo', '0.12.0').command).toContain('git pull');
    expect(updatePlan('repo', '0.12.0').canApply).toBe(false);
    const unknown = updatePlan('unknown', '0.12.0');
    expect(unknown.canApply).toBe(false);
    expect(unknown.command).toBeUndefined();
    expect(unknown.note).toBeTruthy();
  });
});

describe('feed parsing', () => {
  it('parses valid SHA256SUMS lines and ignores malformed entries', () => {
    expect(
      parseSha256Sums(
        'A'.repeat(64) + '  hypergated-1.0.2.tgz\n' +
          'b'.repeat(64) + '  hypergate-shell-linux-x64-1.0.2.tgz\r\n' +
          'not-a-checksum  nope.tgz\n',
      ),
    ).toEqual({
      'hypergated-1.0.2.tgz': 'a'.repeat(64),
      'hypergate-shell-linux-x64-1.0.2.tgz': 'b'.repeat(64),
    });
  });
  it('reads dist-tags.latest from an npm document', () => {
    expect(latestFromNpm({ 'dist-tags': { latest: '0.12.0', next: '0.13.0-rc.1' } })).toBe('0.12.0');
    expect(latestFromNpm({ error: 'Not found' })).toBeUndefined();
    expect(latestFromNpm({ 'dist-tags': { latest: 'nonsense' } })).toBeUndefined();
    expect(latestFromNpm(null)).toBeUndefined();
  });

  it('reads tag_name from a GitHub release, minus the v, and skips drafts', () => {
    expect(latestFromGithub({ tag_name: 'v0.12.0' })).toBe('0.12.0');
    expect(latestFromGithub({ tag_name: '0.12.0' })).toBe('0.12.0');
    expect(latestFromGithub({ tag_name: 'v0.12.0', draft: true })).toBeUndefined();
    expect(latestFromGithub({ message: 'Not Found' })).toBeUndefined();
  });

  it('points release notes at the tag', () => {
    expect(releaseUrlFor('0.12.0')).toBe('https://github.com/nekko-labs/hypergate/releases/tag/v0.12.0');
  });
});

describe('resolving what an update would download', () => {
  const npmDocs = {
    main: {
      versions: {
        '0.15.0': {
          dist: { tarball: 'https://registry.npmjs.org/hypergated/-/hypergated-0.15.0.tgz', integrity: 'sha512-abc', shasum: 'deadbeef' },
        },
      },
    },
    shell: {
      versions: {
        '0.15.0': { dist: { tarball: 'https://registry.npmjs.org/hypergate-shell-win32-x64/-/hypergate-shell-win32-x64-0.15.0.tgz' } },
      },
    },
  };

  it('names the platform package the way the publisher does', () => {
    expect(shellPackageFor('win32', 'x64')).toBe('hypergate-shell-win32-x64');
    expect(shellPackageFor('darwin', 'arm64')).toBe('hypergate-shell-darwin-arm64');
  });

  it('takes both tarballs from npm, shell first, with its integrity hash', () => {
    const assets = assetsFromNpm(npmDocs, '0.15.0', 'win32', 'x64');
    expect(assets.map((a) => a.name)).toEqual(['hypergate-shell-win32-x64-0.15.0.tgz', 'hypergated-0.15.0.tgz']);
    expect(assets[1].integrity).toBe('sha512-abc');
    expect(assets[1].shasum).toBe('deadbeef');
  });

  it('is still an update when the platform has no shell build, but never shell-only', () => {
    expect(assetsFromNpm({ main: npmDocs.main }, '0.15.0', 'sunos', 'x64')).toHaveLength(1);
    expect(assetsFromNpm({ main: undefined, shell: npmDocs.shell }, '0.15.0', 'win32', 'x64')).toEqual([]);
  });

  it('resolves nothing for a version the feed does not carry', () => {
    expect(assetsFromNpm(npmDocs, '0.16.0', 'win32', 'x64')).toEqual([]);
  });

  it('takes the same two tarballs off a GitHub release, by exact name', () => {
    const doc = {
      assets: [
        { name: 'Hypergate-0.15.0-setup.exe', browser_download_url: 'https://github.com/x/setup.exe', size: 9 },
        { name: 'hypergated-0.15.0.tgz', browser_download_url: 'https://github.com/x/hypergated-0.15.0.tgz', size: 2_000_000 },
        {
          name: 'hypergate-shell-win32-x64-0.15.0.tgz',
          browser_download_url: 'https://github.com/x/hypergate-shell-win32-x64-0.15.0.tgz',
          size: 1_500_000,
        },
        { name: 'hypergate-shell-linux-x64-0.15.0.tgz', browser_download_url: 'https://github.com/x/linux.tgz', size: 1 },
      ],
    };
    const assets = assetsFromGithub(
      doc,
      '0.15.0',
      'win32',
      'x64',
      `${'a'.repeat(64)}  hypergate-shell-win32-x64-0.15.0.tgz\n${'b'.repeat(64)}  hypergated-0.15.0.tgz\n`,
    );
    expect(assets.map((a) => a.name)).toEqual(['hypergate-shell-win32-x64-0.15.0.tgz', 'hypergated-0.15.0.tgz']);
    // The size is what makes the progress bar real rather than a guess.
    expect(assets.reduce((n, a) => n + (a.size ?? 0), 0)).toBe(3_500_000);
    expect(assets[0].sha256).toBe('a'.repeat(64));
    expect(assets[1].sha256).toBe('b'.repeat(64));
    // Another architecture's build is not "close enough".
    expect(assetsFromGithub(doc, '0.15.0', 'darwin', 'arm64').map((a) => a.name)).toEqual(['hypergated-0.15.0.tgz']);
  });

  it('accepts https anywhere, and plaintext only on loopback', () => {
    expect(downloadableUrl('https://github.com/x/y.tgz')).toBe(true);
    expect(downloadableUrl('http://localhost:7921/tarball/x.tgz')).toBe(true);
    expect(downloadableUrl('http://127.0.0.1:7921/x.tgz')).toBe(true);
    expect(downloadableUrl('http://registry.internal/x.tgz')).toBe(false);
    expect(downloadableUrl('file:///etc/passwd')).toBe(false);
    expect(downloadableUrl('not a url')).toBe(false);
    expect(downloadableUrl(undefined)).toBe(false);
  });

  it('refuses a release that carries no packages, and any URL that is not fetchable', () => {
    expect(assetsFromGithub({ assets: [] }, '0.15.0', 'win32', 'x64')).toEqual([]);
    expect(assetsFromGithub({ message: 'Not Found' }, '0.15.0', 'win32', 'x64')).toEqual([]);
    expect(
      assetsFromGithub(
        { assets: [{ name: 'hypergated-0.15.0.tgz', browser_download_url: 'http://evil.example/x.tgz' }] },
        '0.15.0',
        'win32',
        'x64',
      ),
    ).toEqual([]);
    expect(
      assetsFromNpm(
        { main: { versions: { '0.15.0': { dist: { tarball: 'http://evil.example/x.tgz' } } } } },
        '0.15.0',
        'win32',
        'x64',
      ),
    ).toEqual([]);
  });
});
