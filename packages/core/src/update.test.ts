import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  detectInstallChannel,
  isNewerVersion,
  latestFromGithub,
  latestFromNpm,
  releaseUrlFor,
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
