import { describe, it, expect } from 'vitest';
import { REGISTRY, RECOMMENDED_IDS, sortRegistry, registryEntry } from './registry.js';
import { KNOWN_CLIS, knownCli } from './clis.js';
import { mergeCatalogSearch, type RegistryEntry } from '@hypergate/shared';

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

  it('uses a bearer token for the GitHub remote entry', () => {
    expect(registryEntry('github')).toMatchObject({
      runtime: 'remote',
      url: 'https://api.githubcopilot.com/mcp/',
      transport: 'http',
      auth: 'token',
      tokenLabel: 'GitHub personal access token',
      tokenUrl: 'https://github.com/settings/personal-access-tokens',
      official: true,
      homepage: 'https://github.com/github/github-mcp-server',
    });
  });

  it('has the whole recommended set present + flagged recommended', () => {
    for (const id of RECOMMENDED_IDS) {
      const e = registryEntry(id);
      expect(e, id).toBeDefined();
      expect(e!.recommended, id).toBe(true);
    }
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
