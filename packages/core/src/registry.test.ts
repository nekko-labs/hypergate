import { describe, it, expect } from 'vitest';
import { REGISTRY, RECOMMENDED_IDS, sortRegistry, registryEntry } from './registry.js';
import { KNOWN_CLIS, knownCli } from './clis.js';
import { mergeCatalogSearch, registryConnections, resolveRegistryConnection, type RegistryEntry } from '@hypergate/shared';

const entry = (id: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id,
  name: id,
  description: '',
  runtime: 'process',
  command: 'x',
  ...over,
});

describe('REGISTRY catalog', () => {
  it('has unique ids', () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the requested official servers, flagged official', () => {
    for (const id of ['supabase', 'linear', 'figma', 'atlassian', 'azure', 'aws', 'gcp-toolbox', 'cloudflare', 'higgsfield', 'meta-ads', 'kotrain', 'vercel']) {
      const e = registryEntry(id);
      expect(e, id).toBeDefined();
      expect(e!.official, id).toBe(true);
    }
  });

  it('uses Vercel’s verified remote OAuth endpoint', () => {
    expect(registryEntry('vercel')).toMatchObject({
      runtime: 'remote',
      url: 'https://mcp.vercel.com',
      transport: 'http',
      auth: 'oauth',
      command: '',
    });
  });

  it('groups GitHub OAuth, token, and local connections with OAuth as default', () => {
    expect(registryEntry('github')).toMatchObject({
      runtime: 'remote',
      url: 'https://api.githubcopilot.com/mcp/',
      transport: 'http',
      auth: 'oauth',
      official: true,
      homepage: 'https://github.com/github/github-mcp-server',
    });
    expect(registryEntry('github')?.connections?.map((connection) => connection.id)).toEqual(['oauth', 'token', 'local']);
    // GitHub has no dynamic client registration, so the OAuth option has to carry
    // the one-time app setup with it or it can only ever fail.
    expect(registryEntry('github')?.connections?.[0]).toMatchObject({
      label: 'Sign in with GitHub',
      auth: 'oauth',
      oauthApp: { registerUrl: 'https://github.com/settings/applications/new', secretRequired: true },
    });
    expect(registryEntry('github')?.oauthApp?.secretRequired).toBe(true);
    expect(registryEntry('github')?.connections?.[1]).toMatchObject({
      label: 'API key or token',
      auth: 'token',
      tokenLabel: 'GitHub personal access token',
    });
    // Running it locally means GitHub's own image, not the npm reference server —
    // that package is marked "no longer supported" on npm.
    expect(registryEntry('github')?.connections?.[2]).toMatchObject({
      label: 'Run locally',
      runtime: 'docker',
      image: 'ghcr.io/github/github-mcp-server',
      requires: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    });
    expect(registryEntry('github-pat')).toBeUndefined();
  });

  it('has the whole recommended set present + flagged recommended', () => {
    for (const id of RECOMMENDED_IDS) {
      const e = registryEntry(id);
      expect(e, id).toBeDefined();
      expect(e!.recommended, id).toBe(true);
    }
  });
});

describe('registry connection helpers', () => {
  it('synthesizes one option from an ungrouped entry', () => {
    const e = entry('plain', { auth: 'token', tokenLabel: 'API token' });
    expect(registryConnections(e)).toEqual([expect.objectContaining({
      id: 'default',
      label: 'Default',
      runtime: 'process',
      command: 'x',
      auth: 'token',
      tokenLabel: 'API token',
    })]);
  });

  it('resolves a selected option while retaining entry metadata', () => {
    const e = entry('grouped', {
      name: 'Grouped',
      connections: [
        { id: 'oauth', label: 'Auto-connect', runtime: 'remote', command: '', url: 'https://example.test/mcp', auth: 'oauth' },
        { id: 'local', label: 'Run locally', runtime: 'process', command: 'npx', args: ['server'], requires: ['TOKEN'] },
        { id: 'minimal', label: 'Minimal', runtime: 'process' },
      ],
    });
    const local = resolveRegistryConnection(e, 'local');
    expect(local).toMatchObject({
      id: 'grouped',
      name: 'Grouped',
      runtime: 'process',
      command: 'npx',
      args: ['server'],
      requires: ['TOKEN'],
    });
    expect(local.url).toBeUndefined();
    expect(local.transport).toBeUndefined();
    expect(local.auth).toBeUndefined();
    expect(local.connections).toBeUndefined();
    expect(resolveRegistryConnection(e, 'minimal').command).toBe('');
    expect(resolveRegistryConnection(e, 'missing')).toMatchObject({ runtime: 'remote', auth: 'oauth' });
  });
});

describe('mergeCatalogSearch', () => {
  it('puts matching curated entries first and removes duplicate endpoints', () => {
    const curated = [
      entry('vercel', { name: 'Vercel', description: 'Deploy projects', runtime: 'remote', command: '', url: 'https://mcp.vercel.com', auth: 'oauth' }),
      entry('github', { name: 'GitHub' }),
    ];
    const searched = [
      entry('com-pulsemcp-vercel', { name: 'vercel' }),
      entry('com-vercel-vercel-mcp', { name: 'vercel-mcp', runtime: 'remote', command: '', url: 'https://mcp.vercel.com/' }),
    ];

    expect(mergeCatalogSearch(curated, searched, 'verc').map((e) => e.id)).toEqual(['vercel', 'com-pulsemcp-vercel']);
  });

  it('does not include unrelated curated entries', () => {
    expect(mergeCatalogSearch([entry('github'), entry('vercel')], [entry('registry-hit')], 'verc').map((e) => e.id)).toEqual([
      'vercel',
      'registry-hit',
    ]);
  });
});

describe('sortRegistry', () => {
  it('puts the recommended set first, in RECOMMENDED_IDS order', () => {
    const sorted = sortRegistry(REGISTRY);
    expect(sorted.slice(0, RECOMMENDED_IDS.length).map((e) => e.id)).toEqual([...RECOMMENDED_IDS]);
  });

  it('orders the non-recommended rest by popularity desc, recommended untouched', () => {
    const entries = [
      entry('a'),
      entry('context7', { recommended: true, runtime: 'remote', command: '' }),
      entry('b'),
      entry('c'),
    ];
    const sorted = sortRegistry(entries, { a: 10, b: 500, c: 100 });
    expect(sorted.map((e) => e.id)).toEqual(['context7', 'b', 'c', 'a']);
  });

  it('is stable when there is no popularity signal', () => {
    const entries = [entry('x'), entry('y'), entry('z')];
    expect(sortRegistry(entries).map((e) => e.id)).toEqual(['x', 'y', 'z']);
  });

  it('falls back to an entry.popularity when the map has none', () => {
    const entries = [entry('a', { popularity: 1 }), entry('b', { popularity: 9 })];
    expect(sortRegistry(entries).map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('KNOWN_CLIS', () => {
  it('has unique ids and covers the common MCP prerequisites', () => {
    const ids = KNOWN_CLIS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['node', 'npx', 'uvx', 'docker', 'flyctl', 'kotrain']) {
      expect(knownCli(id), id).toBeDefined();
    }
  });

  it('every entry has a command + a category', () => {
    for (const c of KNOWN_CLIS) {
      expect(c.command.length, c.id).toBeGreaterThan(0);
      expect(c.category.length, c.id).toBeGreaterThan(0);
    }
  });
});
