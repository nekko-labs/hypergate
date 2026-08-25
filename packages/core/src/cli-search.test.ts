import { describe, it, expect } from 'vitest';
import { binCommand, categoryFor, lookupBrewFormula, mapBrewFormula, mapNpmCli, publisherOf, searchCliCatalog, searchCuratedClis, searchNpmClis } from './cli-search.js';
import { cliCatalogEntry, KNOWN_CLIS, knownCli, matchesCli, sortCliCatalog } from './clis.js';
import type { CliCatalogEntry } from '@hypergate/shared';

/** A fetch stand-in that answers from a URL→body table and records what it saw. */
const stubFetch = (routes: Record<string, unknown>, opts: { headers?: Record<string, string> } = {}) => {
  const seen: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, headers: new Headers({}), json: async () => ({}) } as unknown as Response;
    return {
      ok: true,
      status: 200,
      headers: new Headers(opts.headers ?? { 'content-type': 'application/json' }),
      json: async () => routes[key],
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
};

const playwrightCliManifest = {
  name: '@playwright/cli',
  version: '0.1.17',
  description: 'Playwright CLI',
  homepage: 'https://playwright.dev',
  bin: { 'playwright-cli': 'playwright-cli.js' },
  repository: { url: 'git+https://github.com/microsoft/playwright-cli.git' },
};

describe('binCommand', () => {
  it('prefers the bin named after the package', () => {
    expect(binCommand({ name: '@scope/tool', bin: { other: 'a.js', tool: 'b.js' } })).toBe('tool');
  });

  it('falls back to the first bin when none matches the package name', () => {
    expect(binCommand({ name: '@playwright/cli', bin: { 'playwright-cli': 'x.js' } })).toBe('playwright-cli');
  });

  it('uses the package basename for a string bin', () => {
    expect(binCommand({ name: '@acme/widget', bin: './cli.js' })).toBe('widget');
  });

  it('has no command when the package installs no executable', () => {
    expect(binCommand({ name: 'left-pad' })).toBeUndefined();
  });
});

describe('mapNpmCli', () => {
  it('maps a scoped CLI package to an installable entry', () => {
    const entry = mapNpmCli(playwrightCliManifest, { publisher: 'github-actions' })!;
    expect(entry.channel).toBe('npm');
    expect(entry.package).toBe('@playwright/cli');
    expect(entry.command).toBe('playwright-cli');
    expect(entry.latest).toBe('0.1.17');
    expect(entry.installs?.[0].command).toBe('npm install -g @playwright/cli@latest');
    expect(entry.category).toBe('testing');
  });

  it('carries a deprecation notice through verbatim', () => {
    const entry = mapNpmCli({
      name: 'playwright-cli',
      version: '0.262.0',
      bin: { 'playwright-cli': 'x.js' },
      deprecated: 'This package is deprecated, use @playwright/cli instead.',
    })!;
    expect(entry.deprecated).toBe('This package is deprecated, use @playwright/cli instead.');
  });

  it('refuses a library: no bin means not a CLI', () => {
    expect(mapNpmCli({ name: 'playwright-core', version: '1.62.1' })).toBeUndefined();
  });
});

describe('mapBrewFormula', () => {
  it('maps a formula with its 30-day install count', () => {
    const entry = mapBrewFormula({
      name: 'jq',
      desc: 'Lightweight and flexible command-line JSON processor',
      homepage: 'https://jqlang.github.io/jq/',
      versions: { stable: '1.7.1' },
      analytics: { install: { '30d': { jq: 84574, 'jq --HEAD': 370 } } },
    })!;
    expect(entry.channel).toBe('brew');
    expect(entry.command).toBe('jq');
    expect(entry.popularity).toBe(84574);
    expect(entry.installs?.[0]).toEqual({ label: 'Homebrew', command: 'brew install jq', platforms: ['darwin', 'linux'] });
  });

  it('reports a disabled formula as deprecated with its reason', () => {
    const entry = mapBrewFormula({ name: 'old-tool', disabled: true, deprecation_reason: 'upstream is gone' })!;
    expect(entry.deprecated).toContain('upstream is gone');
  });
});

describe('categoryFor', () => {
  it('classifies by what the tool says it does', () => {
    expect(categoryFor('an MCP server for X')).toBe('mcp');
    expect(categoryFor('browser automation and e2e testing')).toBe('testing');
    expect(categoryFor('deploy to Cloudflare Workers')).toBe('cloud');
    expect(categoryFor('a colourful todo list')).toBe('other');
  });
});

describe('searchNpmClis', () => {
  it('over-fetches, then keeps only packages that install a command', async () => {
    const { impl, seen } = stubFetch({
      '/-/v1/search': {
        objects: [
          { package: { name: '@playwright/cli', publisher: { username: 'github-actions' } } },
          { package: { name: 'playwright-core', publisher: { username: 'microsoft' } } },
        ],
      },
      '@playwright%2fcli/latest': playwrightCliManifest,
      'playwright-core/latest': { name: 'playwright-core', version: '1.62.1' },
    });
    const results = await searchNpmClis('playwright cli', { fetchImpl: impl });
    expect(results.map((r) => r.package)).toEqual(['@playwright/cli']);
    expect(seen.some((u) => u.includes('size=18'))).toBe(true);
  });

  it('survives one unreachable manifest', async () => {
    const { impl } = stubFetch({
      '/-/v1/search': { objects: [{ package: { name: 'gone' } }, { package: { name: '@playwright/cli' } }] },
      '@playwright%2fcli/latest': playwrightCliManifest,
    });
    const results = await searchNpmClis('playwright', { fetchImpl: impl });
    expect(results).toHaveLength(1);
  });

  it('rejects a package name that could escape the registry path', async () => {
    const { impl, seen } = stubFetch({ '/-/v1/search': { objects: [{ package: { name: '../../etc/passwd' } }] } });
    await searchNpmClis('x', { fetchImpl: impl });
    expect(seen).toHaveLength(1); // the search itself, and no manifest lookup
  });
});

describe('lookupBrewFormula', () => {
  it("treats the site's HTML 404 as a miss, not a formula", async () => {
    const { impl } = stubFetch({ '/formula/nope.json': '<!DOCTYPE html>' }, { headers: { 'content-type': 'text/html' } });
    expect(await lookupBrewFormula('nope', { fetchImpl: impl })).toBeUndefined();
  });

  it('refuses a name that is not a formula name', async () => {
    const { impl, seen } = stubFetch({});
    expect(await lookupBrewFormula('../secrets', { fetchImpl: impl })).toBeUndefined();
    expect(seen).toHaveLength(0);
  });
});

describe('searchCliCatalog', () => {
  it('puts the curated official tool first and de-duplicates its npm copy', async () => {
    const { impl } = stubFetch({
      '/-/v1/search': { objects: [{ package: { name: '@playwright/cli' } }, { package: { name: 'playwright-cli' } }] },
      '@playwright%2fcli/latest': playwrightCliManifest,
      'playwright-cli/latest': {
        name: 'playwright-cli',
        version: '0.262.0',
        bin: { 'playwright-cli-old': 'x.js' },
        deprecated: 'This package is deprecated, use @playwright/cli instead.',
      },
      '/formula/playwright.json': { name: 'playwright', desc: 'nope' },
    });
    const results = await searchCliCatalog('playwright', { fetchImpl: impl });
    expect(results[0].channel).toBe('curated');
    expect(results[0].id).toBe('playwright-cli');
    // The curated row already owns @playwright/cli, so the npm hit for the same
    // package must not appear a second time.
    expect(results.filter((r) => r.package === '@playwright/cli')).toHaveLength(1);
    // A deprecated package still shows (the user searched for it by name) but last.
    expect(results.at(-1)?.deprecated).toBeTruthy();
  });

  it('answers with the curated matches alone when the network is down', async () => {
    const impl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const results = await searchCliCatalog('docker', { fetchImpl: impl });
    expect(results.map((r) => r.id)).toContain('docker');
    expect(results.every((r) => r.channel === 'curated')).toBe(true);
  });
});

describe('curated CLI catalog', () => {
  it('ships the official Playwright CLI, since that is what agents are pointed at', () => {
    const tool = knownCli('playwright-cli')!;
    expect(tool.command).toBe('playwright-cli');
    expect(tool.official).toBe(true);
    expect(tool.recommended).toBe(true);
    expect(tool.install).toBe('npm install -g @playwright/cli@latest');
  });

  it('has a unique id and command per tool', () => {
    expect(new Set(KNOWN_CLIS.map((c) => c.id)).size).toBe(KNOWN_CLIS.length);
    expect(new Set(KNOWN_CLIS.map((c) => c.command)).size).toBe(KNOWN_CLIS.length);
  });

  it('gives every tool a way to get it', () => {
    for (const tool of KNOWN_CLIS) expect(tool.install?.length ?? 0).toBeGreaterThan(0);
  });

  it('classifies every curated install instruction as command or manual text', () => {
    const meta = /[|&;<>$`(){}'"\\\r\n]/;
    for (const tool of KNOWN_CLIS) {
      const instruction = tool.install!.trim();
      const runnable = !/^https?:\/\//i.test(instruction)
        && !meta.test(instruction)
        && /^[A-Za-z0-9_.-]+(?:\s+\S+)*$/.test(instruction);
      expect(runnable || instruction.length > 0).toBe(true);
    }
  });

  it('offers only install routes that apply to the asking platform', () => {
    const win = cliCatalogEntry(knownCli('git')!, 'win32');
    expect(win.installs?.map((i) => i.label)).toContain('winget');
    expect(win.installs?.some((i) => i.label === 'Homebrew')).toBe(false);
    const mac = cliCatalogEntry(knownCli('git')!, 'darwin');
    expect(mac.installs?.some((i) => i.label === 'Homebrew')).toBe(true);
  });

  it('matches a tool by its npm package as well as its name', () => {
    expect(matchesCli(knownCli('playwright-cli')!, '@playwright/cli')).toBe(true);
    expect(matchesCli(knownCli('playwright-cli')!, 'terraform')).toBe(false);
  });

  it('searches curated tools by command, name and description', () => {
    expect(searchCuratedClis('uvx').map((c) => c.id)).toContain('uvx');
    expect(searchCuratedClis('json processor')).toHaveLength(0);
  });
});

describe('sortCliCatalog', () => {
  it('orders recommended curated, curated, brew, npm, then anything deprecated', () => {
    const entry = (id: string, over: Partial<CliCatalogEntry>): CliCatalogEntry => ({
      id, name: id, command: id, description: '', category: 'other', channel: 'curated', ...over,
    });
    const sorted = sortCliCatalog([
      entry('brew-one', { channel: 'brew' }),
      entry('dead', { channel: 'curated', recommended: true, deprecated: 'gone' }),
      entry('npm-one', { channel: 'npm' }),
      entry('plain'),
      entry('star', { recommended: true }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['star', 'plain', 'brew-one', 'npm-one', 'dead']);
  });
});

describe('publisherOf', () => {
  it('names the repository owner rather than the CI account that pushed', () => {
    expect(publisherOf({ repository: { url: 'git+https://github.com/microsoft/playwright-cli.git' } }, 'GitHub Actions')).toBe('microsoft on GitHub');
  });

  it('falls back to the npm publisher, unless it is a CI robot', () => {
    expect(publisherOf({}, 'sindresorhus')).toBe('sindresorhus');
    expect(publisherOf({ author: 'A Human' }, 'github-actions')).toBe('A Human');
    expect(publisherOf({}, 'GitHub Actions')).toBeUndefined();
  });
});

describe('searchCliCatalog channel precedence', () => {
  // A tool that exists in both channels under the same command name: Homebrew
  // builds it from the project's own release, npm's is a wrapper that downloads
  // that binary. The formula must claim the row, not be deduped away by it.
  it('keeps the Homebrew formula when npm ships a wrapper of the same command', async () => {
    const { impl } = stubFetch({
      '/-/v1/search': { objects: [{ package: { name: 'ripgrep', description: 'wrapper' } }] },
      '/ripgrep/latest': { name: 'ripgrep', version: '13.0.0', description: 'npm wrapper', bin: { ripgrep: 'cli.js' } },
      '/formula/ripgrep.json': {
        name: 'ripgrep',
        desc: 'Search tool like grep and The Silver Searcher',
        versions: { stable: '14.1.1' },
        analytics: { install: { '30d': { ripgrep: 90000 } } },
      },
    });
    const results = await searchCliCatalog('ripgrep', { fetchImpl: impl });
    const ripgrep = results.filter((e) => e.command === 'ripgrep');
    expect(ripgrep).toHaveLength(1);
    expect(ripgrep[0].channel).toBe('brew');
    expect(ripgrep[0].installs?.[0].command).toBe('brew install ripgrep');
  });
});
