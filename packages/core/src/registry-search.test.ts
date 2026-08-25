import { describe, it, expect } from 'vitest';
import { mapRegistryServer, searchRegistry, officialFromNamespace, resolveServer } from './registry-search.js';

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

  it('connects a remote-only server rather than refusing it', () => {
    // Was: asserted `runnable: false`. That encoded the gap, not a requirement —
    // a hosted endpoint is connectable, and this is three quarters of the registry.
    const e = mapRegistryServer({
      name: 'ai.smithery/hosted-thing',
      remotes: [{ type: 'streamable-http', url: 'https://smithery.ai/mcp' }],
    });
    expect(e.runnable).toBe(true);
    expect(e.runtime).toBe('remote');
    expect(e.url).toBe('https://smithery.ai/mcp');
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

describe('mapRegistryServer — remote servers', () => {
  it('maps a streamable-http remote to a connectable remote entry', () => {
    // 75% of the live registry is remote-only. Refusing all of it as "not
    // locally runnable" turned three quarters of the catalog into dead rows,
    // while Hypergate has had a `remote` runtime the whole time.
    const e = mapRegistryServer({
      name: 'ac.inference.sh/mcp',
      description: 'Inference tools',
      remotes: [{ type: 'streamable-http', url: 'https://api.inference.sh/mcp' }],
    });
    expect(e.runtime).toBe('remote');
    expect(e.url).toBe('https://api.inference.sh/mcp');
    expect(e.transport).toBe('http');
    expect(e.auth).toBe('oauth');
    expect(e.command).toBe('');
    expect(e.runnable).toBe(true);
  });

  it('carries the legacy sse transport through', () => {
    const e = mapRegistryServer({ name: 'io.github.a/b', remotes: [{ type: 'sse', url: 'https://x.dev/sse' }] });
    expect(e.runtime).toBe('remote');
    expect(e.transport).toBe('sse');
  });

  it('prefers a runnable package over a remote when a server offers both', () => {
    const e = mapRegistryServer({
      name: 'io.github.a/b',
      packages: [{ registryType: 'npm', identifier: '@a/b', version: '1.0.0' }],
      remotes: [{ type: 'streamable-http', url: 'https://x.dev/mcp' }],
    });
    expect(e.runtime).toBe('process');
    expect(e.command).toBe('npx');
  });

  it('still refuses a remote with no usable url', () => {
    const e = mapRegistryServer({ name: 'io.github.a/b', remotes: [{ type: 'streamable-http' }] });
    expect(e.runnable).toBe(false);
  });
});

describe('mapRegistryServer — platform binaries', () => {
  it('names the platform when an mcpb bundle is all there is', () => {
    const e = mapRegistryServer({
      name: 'com.microsoft/azure',
      packages: [{ registryType: 'mcpb', identifier: 'https://x/Azure-win-x64.mcpb', fileSha256: 'abc' }],
    });
    expect(e.runnable).toBe(false);
    expect(e.note).toMatch(/mcpb/i);
  });
});

describe('searchRegistry version selection', () => {
  const rows = (versions: string[]) => ({
    servers: versions.map((version) => ({
      server: {
        name: 'ai.aetherwealth/mcp',
        version,
        packages: [{ registryType: 'npm', identifier: '@ae/mcp', version }],
      },
    })),
  });

  it('keeps the newest stable version, not the first row returned', async () => {
    // The registry returns versions ascending and lexically sorted, so the old
    // "keep the first" dedupe pinned this server to 0.2.0 forever.
    const fetchImpl = (async () => ({ ok: true, json: async () => rows(['0.2.0', '0.2.11', '0.2.2', '0.2.14']) })) as unknown as typeof fetch;
    const out = await searchRegistry('ae', { fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].args).toEqual(['-y', '@ae/mcp@0.2.14']);
  });

  it('does not pin a user to a prerelease when a stable release exists', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => rows(['2.0.0', '2.0.2', '3.0.0-beta.37']) })) as unknown as typeof fetch;
    const out = await searchRegistry('azure', { fetchImpl });
    expect(out[0].args).toEqual(['-y', '@ae/mcp@2.0.2']);
  });
});

describe('resolveServer', () => {
  // A fetch stub that serves the two endpoints resolveServer uses.
  const stub = (opts: { search: { name: string; version?: string }[]; versions?: Record<string, unknown[]> }) =>
    (async (input: string) => {
      const url = String(input);
      const m = /\/v0\/servers\/([^/]+)\/versions/.exec(url);
      if (m) {
        const name = decodeURIComponent(m[1]);
        return { ok: true, json: async () => ({ servers: (opts.versions?.[name] ?? []).map((server) => ({ server })) }) };
      }
      return { ok: true, json: async () => ({ servers: opts.search.map((server) => ({ server })) }) };
    }) as unknown as typeof fetch;

  const azurePkgs = (version: string) => [
    {
      registryType: 'npm',
      identifier: '@azure/mcp',
      version,
      packageArguments: [
        { type: 'positional', value: 'server' },
        { type: 'positional', value: 'start' },
      ],
    },
  ];

  it('resolves an exact name to the newest stable version, ignoring newer prereleases', async () => {
    const fetchImpl = stub({
      search: [{ name: 'com.microsoft/azure' }, { name: 'com.microsoft/azure-devops' }],
      versions: {
        'com.microsoft/azure': ['2.0.0', '2.0.2', '3.0.0-beta.37', '2.0.0-beta.40'].map((version) => ({
          name: 'com.microsoft/azure',
          version,
          packages: azurePkgs(version),
        })),
      },
    });
    const r = await resolveServer('com.microsoft/azure', { fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe('com.microsoft/azure');
    expect(r.version).toBe('2.0.2');
    // Microsoft's own documented invocation, derived from registry metadata alone.
    expect(r.entry.command).toBe('npx');
    expect(r.entry.args).toEqual(['-y', '@azure/mcp@2.0.2', 'server', 'start']);
  });

  it('takes the newest prerelease only when asked', async () => {
    const fetchImpl = stub({
      search: [{ name: 'com.microsoft/azure' }],
      versions: {
        'com.microsoft/azure': ['2.0.2', '3.0.0-beta.37'].map((version) => ({ name: 'com.microsoft/azure', version, packages: azurePkgs(version) })),
      },
    });
    const r = await resolveServer('com.microsoft/azure', { fetchImpl, allowPrerelease: true });
    expect(r.ok && r.version).toBe('3.0.0-beta.37');
  });

  it('goes straight to the version history for a fully-qualified name', async () => {
    // The search endpoint is measured between 0.9s and 24s for the same query;
    // the versions endpoint answers in under a second. An exact name needs only
    // the latter, so the slow call should not happen at all.
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(String(input));
      return {
        ok: true,
        json: async () => ({
          servers: ['1.0.0', '1.2.0'].map((version) => ({
            server: { name: 'io.github.a/b', version, packages: [{ registryType: 'npm', identifier: '@a/b', version }] },
          })),
        }),
      };
    }) as unknown as typeof fetch;
    const r = await resolveServer('io.github.a/b', { fetchImpl });
    expect(r.ok && r.version).toBe('1.2.0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/versions');
    expect(calls.some((c) => c.includes('search='))).toBe(false);
  });

  it('falls back to searching when a slashed name is not an exact server', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/versions')) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ servers: [{ server: { name: 'io.github.owner/thing-mcp', version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@o/t', version: '1.0.0' }] } }] }),
      };
    }) as unknown as typeof fetch;
    const r = await resolveServer('owner/thing', { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.ok && r.name).toBe('io.github.owner/thing-mcp');
    expect(calls.some((c) => c.includes('search='))).toBe(true);
  });

  it('refuses to guess between several matches', async () => {
    const fetchImpl = stub({ search: [{ name: 'com.microsoft/azure' }, { name: 'com.azurecarbon/kodiak' }] });
    const r = await resolveServer('azure', { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates).toEqual(['com.microsoft/azure', 'com.azurecarbon/kodiak']);
  });

  it('reports not_found rather than throwing', async () => {
    const fetchImpl = stub({ search: [] });
    const r = await resolveServer('nothing-like-this', { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
  });

  it('falls back to the search row when the versions endpoint is unavailable', async () => {
    const fetchImpl = (async (input: string) => {
      if (String(input).includes('/versions')) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          servers: [{ server: { name: 'io.github.a/b', version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@a/b', version: '1.0.0' }] } }],
        }),
      };
    }) as unknown as typeof fetch;
    const r = await resolveServer('io.github.a/b', { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.ok && r.version).toBe('1.0.0');
  });
});
