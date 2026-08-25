import { describe, it, expect } from 'vitest';
import {
  isPrerelease,
  bestVersion,
  bestRow,
  resolveServerName,
  selectPackage,
  platformTargets,
  serverConfigFromEntry,
} from './resolve.js';

describe('isPrerelease', () => {
  it('detects a semver prerelease suffix', () => {
    expect(isPrerelease('3.0.0-beta.37')).toBe(true);
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('2.0.2')).toBe(false);
    expect(isPrerelease('1.2.3+build.5')).toBe(false);
  });
});

describe('bestVersion', () => {
  it('orders numerically, not lexically', () => {
    // The exact shape of the live bug: an ASCII sort ranks 0.2.2 above 0.2.14,
    // so a lexical "newest" picks a version that is four releases old.
    expect(bestVersion(['0.2.0', '0.2.11', '0.2.2', '0.2.14'])).toBe('0.2.14');
  });

  it('prefers the newest stable over a newer prerelease', () => {
    // com.microsoft/azure, exactly: registry `version=latest` is 3.0.0-beta.37.
    expect(bestVersion(['2.0.0', '2.0.2', '3.0.0-beta.37'])).toBe('2.0.2');
  });

  it('falls back to the newest prerelease when nothing stable exists', () => {
    expect(bestVersion(['0.1.0-alpha.1', '0.1.0-alpha.4'])).toBe('0.1.0-alpha.4');
  });

  it('returns the newest prerelease when explicitly allowed', () => {
    expect(bestVersion(['2.0.2', '3.0.0-beta.37'], { allowPrerelease: true })).toBe('3.0.0-beta.37');
  });

  it('is undefined for no input', () => {
    expect(bestVersion([])).toBeUndefined();
  });
});

describe('bestRow', () => {
  it('picks the newest stable row, not the first one the registry returned', () => {
    // The live bug: the registry returns versions ascending and the old dedupe
    // kept the first, pinning every multi-version server to its oldest release.
    const rows = [{ version: '0.2.0' }, { version: '0.2.11' }, { version: '0.2.2' }, { version: '0.2.14' }];
    expect(bestRow(rows)?.version).toBe('0.2.14');
  });

  it('handles rows with no version at all', () => {
    expect(bestRow([{ version: undefined }, { version: '1.0.0' }])?.version).toBe('1.0.0');
    expect(bestRow([])).toBeUndefined();
  });
});

describe('resolveServerName', () => {
  const servers = [
    { name: 'com.microsoft/azure' },
    { name: 'com.microsoft/azure-devops' },
    { name: 'com.azurecarbon/kodiak' },
  ];

  it('takes an exact name over any prefix sibling', () => {
    // `?name=` on the live registry does not filter reliably, so exact matching
    // has to happen here or `add com.microsoft/azure` can install azure-devops.
    const r = resolveServerName('com.microsoft/azure', servers);
    expect(r.match?.name).toBe('com.microsoft/azure');
    expect(r.ambiguous).toBe(false);
  });

  it('is case- and whitespace-insensitive on the exact match', () => {
    expect(resolveServerName('  COM.MICROSOFT/Azure ', servers).match?.name).toBe('com.microsoft/azure');
  });

  it('reports ambiguity instead of guessing when only partials match', () => {
    const r = resolveServerName('azure', servers);
    expect(r.match).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map((c) => c.name)).toEqual([
      'com.microsoft/azure',
      'com.microsoft/azure-devops',
      'com.azurecarbon/kodiak',
    ]);
  });

  it('resolves a unique partial match', () => {
    const r = resolveServerName('kodiak', servers);
    expect(r.match?.name).toBe('com.azurecarbon/kodiak');
    expect(r.ambiguous).toBe(false);
  });

  it('finds nothing for an unknown name', () => {
    const r = resolveServerName('nope', servers);
    expect(r.match).toBeUndefined();
    expect(r.ambiguous).toBe(false);
    expect(r.candidates).toEqual([]);
  });
});

describe('selectPackage', () => {
  const azure = [
    { registryType: 'nuget', identifier: 'Azure.Mcp', version: '2.0.2' },
    { registryType: 'npm', identifier: '@azure/mcp', version: '2.0.2' },
    { registryType: 'pypi', identifier: 'msmcp-azure', version: '2.0.2' },
    { registryType: 'mcpb', identifier: 'https://example.com/Azure.Mcp.Server-osx-arm64.mcpb', fileSha256: 'aaa' },
    { registryType: 'mcpb', identifier: 'https://example.com/Azure.Mcp.Server-win-x64.mcpb', fileSha256: 'bbb' },
  ];

  it('prefers npm over every other channel', () => {
    const p = selectPackage(azure, { platform: 'darwin', arch: 'arm64' });
    expect(p?.type).toBe('npm');
    expect(p?.identifier).toBe('@azure/mcp');
  });

  it('falls back through pypi and oci when there is no npm package', () => {
    expect(selectPackage([{ registryType: 'pypi', identifier: 'x' }], {})?.type).toBe('pypi');
    expect(selectPackage([{ registryType: 'oci', identifier: 'ghcr.io/x/y' }], {})?.type).toBe('oci');
  });

  it('matches an mcpb binary to this platform and keeps its hash', () => {
    const only = azure.filter((p) => p.registryType === 'mcpb');
    const p = selectPackage(only, { platform: 'darwin', arch: 'arm64' });
    expect(p?.type).toBe('mcpb');
    expect(p?.identifier).toContain('osx-arm64');
    expect(p?.sha256).toBe('aaa');
  });

  it('rejects an mcpb bundle that has no build for this platform', () => {
    const only = [{ registryType: 'mcpb', identifier: 'https://x/thing-linux-x64.mcpb', fileSha256: 'c' }];
    expect(selectPackage(only, { platform: 'darwin', arch: 'arm64' })).toBeUndefined();
  });

  it('is undefined when nothing is installable', () => {
    expect(selectPackage([], {})).toBeUndefined();
  });
});

describe('platformTargets', () => {
  it('maps node platform/arch onto the tokens release assets use', () => {
    expect(platformTargets('darwin', 'arm64')).toContain('osx-arm64');
    expect(platformTargets('darwin', 'arm64')).toContain('darwin-arm64');
    expect(platformTargets('win32', 'x64')).toContain('win-x64');
    expect(platformTargets('linux', 'x64')).toContain('linux-x64');
  });
});

describe('serverConfigFromEntry', () => {
  it('carries a process entry through with its pinned args', () => {
    const cfg = serverConfigFromEntry({
      id: 'com-microsoft-azure',
      name: 'Azure',
      description: '',
      runtime: 'process',
      command: 'npx',
      args: ['-y', '@azure/mcp@2.0.2', 'server', 'start'],
    });
    expect(cfg).toMatchObject({ id: 'com-microsoft-azure', name: 'Azure', runtime: 'process', command: 'npx', enabled: true });
    expect(cfg.args).toEqual(['-y', '@azure/mcp@2.0.2', 'server', 'start']);
  });

  it('carries a remote entry’s endpoint, transport and auth', () => {
    const cfg = serverConfigFromEntry({
      id: 'linear',
      name: 'Linear',
      description: '',
      runtime: 'remote',
      command: '',
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      auth: 'oauth',
      scope: 'read',
    });
    expect(cfg).toMatchObject({ runtime: 'remote', url: 'https://mcp.linear.app/mcp', transport: 'http', auth: 'oauth', scope: 'read', command: '' });
  });

  it('carries a docker image and leaves the command empty', () => {
    const cfg = serverConfigFromEntry({ id: 'g', name: 'G', description: '', runtime: 'docker', command: '', image: 'ghcr.io/x/y:1' });
    expect(cfg).toMatchObject({ runtime: 'docker', image: 'ghcr.io/x/y:1', command: '' });
  });

  it('attaches vault references for the env vars it was given', () => {
    const cfg = serverConfigFromEntry(
      { id: 'x', name: 'X', description: '', runtime: 'process', command: 'npx', args: ['-y', '@x/y'], requires: ['TOKEN'] },
      { credentialRefs: { TOKEN: 'cred-1' } },
    );
    expect(cfg.credentialRefs).toEqual({ TOKEN: 'cred-1' });
  });

  it('omits keys the entry does not set rather than writing undefined into the config', () => {
    const cfg = serverConfigFromEntry({ id: 'x', name: 'X', description: '', runtime: 'process', command: 'npx' });
    expect('image' in cfg).toBe(false);
    expect('url' in cfg).toBe(false);
    expect('credentialRefs' in cfg).toBe(false);
  });
});
