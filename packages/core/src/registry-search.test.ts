import { describe, it, expect } from 'vitest';
import { mapRegistryServer, searchRegistry, officialFromNamespace } from './registry-search.js';

describe('mapRegistryServer', () => {
  it('maps an npm package to an npx process command with env requires', () => {
    const e = mapRegistryServer({
      name: 'io.github.acme/weather',
      title: 'Weather',
      description: 'Weather tools',
      packages: [
        {
          registryType: 'npm',
          identifier: '@acme/weather-mcp',
          version: '1.2.3',
          transport: { type: 'stdio' },
          environmentVariables: [{ name: 'WEATHER_API_KEY', isRequired: true }],
        },
      ],
      repository: { url: 'https://github.com/acme/weather' },
    });
    expect(e.runtime).toBe('process');
    expect(e.command).toBe('npx');
    expect(e.args).toEqual(['-y', '@acme/weather-mcp@1.2.3']);
    expect(e.requires).toEqual(['WEATHER_API_KEY']);
    expect(e.runnable).toBe(true);
    expect(e.source).toBe('registry');
    expect(e.homepage).toBe('https://github.com/acme/weather');
    expect(e.name).toBe('Weather');
  });

  it('maps a pypi package to a uvx command', () => {
    const e = mapRegistryServer({
      name: 'io.github.acme/pytool',
      packages: [{ registryType: 'pypi', identifier: 'acme-mcp', version: '0.1.0', transport: { type: 'stdio' } }],
    });
    expect(e.runtime).toBe('process');
    expect(e.command).toBe('uvx');
    expect(e.args).toEqual(['acme-mcp']);
    expect(e.runnable).toBe(true);
  });

  it('maps an oci package to the docker runtime with an image', () => {
    const e = mapRegistryServer({
      name: 'io.github.acme/dock',
      packages: [{ registryType: 'oci', identifier: 'ghcr.io/acme/mcp', version: '2.0.0', transport: { type: 'stdio' } }],
    });
    expect(e.runtime).toBe('docker');
    expect(e.image).toBe('ghcr.io/acme/mcp:2.0.0');
    expect(e.command).toBe('');
    expect(e.runnable).toBe(true);
  });

  it('flags a remote-only server as not runnable', () => {
    const e = mapRegistryServer({
      name: 'ai.smithery/hosted-thing',
      remotes: [{ type: 'streamable-http', url: 'https://smithery.ai/mcp' }],
    });
    expect(e.runnable).toBe(false);
    expect(e.note).toMatch(/remote/i);
    expect(e.command).toBe('');
  });

  it('derives a short name and slug id from a reverse-DNS name', () => {
    const e = mapRegistryServer({ name: 'io.github.acme/cool-server', packages: [] });
    expect(e.id).toBe('io-github-acme-cool-server');
    expect(e.name).toBe('cool-server');
    expect(e.runnable).toBe(false);
  });

  it('sets publisher + official from the namespace', () => {
    const community = mapRegistryServer({ name: 'io.github.acme/weather', packages: [] });
    expect(community.publisher).toBe('io.github.acme');
    expect(community.official).toBe(false);
    const firstParty = mapRegistryServer({
      name: 'app.linear/linear',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
    });
    expect(firstParty.publisher).toBe('app.linear');
    expect(firstParty.official).toBe(true);
  });
});

describe('officialFromNamespace', () => {
  it('treats a domain-verified namespace as official', () => {
    expect(officialFromNamespace('app.linear')).toBe(true);
    expect(officialFromNamespace('com.atlassian')).toBe(true);
  });
  it('treats github + anonymous namespaces as community', () => {
    expect(officialFromNamespace('io.github.acme')).toBe(false);
    expect(officialFromNamespace('io.modelcontextprotocol.anonymous')).toBe(false);
  });
  it('returns undefined with no namespace, and not-official for a non-domain word', () => {
    expect(officialFromNamespace('')).toBeUndefined();
    expect(officialFromNamespace('bareword')).toBe(false);
  });
});

describe('searchRegistry', () => {
  it('passes the query + limit and maps the response with an injected fetch', async () => {
    let calledUrl = '';
    const fakeFetch = (async (u: string) => {
      calledUrl = u;
      return {
        ok: true,
        json: async () => ({
          servers: [
            {
              server: {
                name: 'io.github.acme/weather',
                title: 'Weather',
                packages: [{ registryType: 'npm', identifier: '@acme/weather-mcp', transport: { type: 'stdio' } }],
              },
            },
          ],
          metadata: { count: 1 },
        }),
      };
    }) as unknown as typeof fetch;

    const results = await searchRegistry('weather', { fetchImpl: fakeFetch, limit: 5 });
    expect(calledUrl).toContain('/v0/servers');
    expect(calledUrl).toContain('search=weather');
    expect(calledUrl).toContain('limit=5');
    expect(results).toHaveLength(1);
    expect(results[0].command).toBe('npx');
  });

  it('keeps one row per server when the registry returns several versions', async () => {
    const version = (v: string) => ({
      server: {
        name: 'io.github.acme/weather',
        title: 'Weather',
        version: v,
        packages: [{ registryType: 'npm', identifier: '@acme/weather-mcp', version: v, transport: { type: 'stdio' } }],
      },
    });
    const fakeFetch = (async () => ({
      ok: true,
      // Newest first, which is how the registry orders them.
      json: async () => ({ servers: [version('3.0.0'), version('2.0.0'), version('1.0.0')], metadata: { count: 3 } }),
    })) as unknown as typeof fetch;

    const results = await searchRegistry('weather', { fetchImpl: fakeFetch });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('io-github-acme-weather');
  });

  it('throws on a non-ok response', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(searchRegistry('x', { fetchImpl: fakeFetch })).rejects.toThrow(/503/);
  });
});
