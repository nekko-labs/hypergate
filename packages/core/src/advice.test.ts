import { describe, it, expect } from 'vitest';
import { adviceForCli, adviceForServer, officialAlternative, preferredFromDeprecation, vendorForPackage } from './advice.js';
import { REGISTRY, registryEntry } from './registry.js';
import { cliCatalogEntry, knownCli } from './clis.js';
import type { CliCatalogEntry, RegistryEntry } from '@hypergate/shared';

const searchHit = (over: Partial<RegistryEntry>): RegistryEntry => ({
  id: 'x', name: 'X', description: '', runtime: 'process', command: 'npx', source: 'registry', ...over,
});

const cli = (over: Partial<CliCatalogEntry>): CliCatalogEntry => ({
  id: 'x', name: 'x', command: 'x', description: '', category: 'other', channel: 'npm', ...over,
});

describe('preferredFromDeprecation', () => {
  it('reads the successor out of npm’s usual wording', () => {
    expect(preferredFromDeprecation('This package is deprecated, use @playwright/cli instead.')).toBe('@playwright/cli');
    expect(preferredFromDeprecation('Superseded by @acme/tool')).toBe('@acme/tool');
    expect(preferredFromDeprecation('This package has moved to `newname`')).toBe('newname');
  });

  it('names nothing when the notice names nothing', () => {
    expect(preferredFromDeprecation('Package no longer supported. Contact Support for more info.')).toBeUndefined();
  });
});

describe('vendorForPackage', () => {
  it('names the vendor only for a scope tied to one', () => {
    expect(vendorForPackage('@playwright/cli')).toBe('Microsoft (Playwright)');
    expect(vendorForPackage('@some-random-person/playwright-tools')).toBeUndefined();
    expect(vendorForPackage('playwright-cli')).toBeUndefined(); // unscoped proves nothing
  });
});

describe('adviceForServer', () => {
  it('calls a curated recommended entry recommended', () => {
    const advice = adviceForServer(registryEntry('context7')!);
    expect(advice.kind).toBe('recommended');
  });

  it('names the CLI alternative on the official Playwright server, and only cross-kind', () => {
    const playwright = adviceForServer(registryEntry('playwright')!);
    expect(playwright.kind).toBe('official');
    expect(playwright.prefer?.kind).toBe('cli');
    // GitHub's own server is the recommendation for GitHub, so nothing is offered
    // in its place.
    expect(adviceForServer(registryEntry('github')!).prefer).toBeUndefined();
  });

  it('trusts a domain-verified registry namespace', () => {
    const advice = adviceForServer(searchHit({ official: true, publisher: 'com.atlassian' }));
    expect(advice.kind).toBe('official');
    expect(advice.message).toContain('com.atlassian');
  });

  it('redirects a community lookalike to the provider’s own server', () => {
    const advice = adviceForServer(searchHit({ name: 'vercel-mcp', official: false, publisher: 'io.github.someone', description: 'Deploy to Vercel' }));
    expect(advice.kind).toBe('superseded');
    expect(advice.prefer?.entryId).toBe('vercel');
  });

  it('still says something useful about a community server with no official rival', () => {
    const advice = adviceForServer(searchHit({ name: 'weather-mcp', official: false, publisher: 'io.github.someone' }));
    expect(advice.kind).toBe('community');
    expect(advice.message).toContain('io.github.someone');
  });

  it('admits when it cannot verify a publisher at all', () => {
    expect(adviceForServer(searchHit({ name: 'mystery' })).kind).toBe('unverified');
  });

  it('has a verdict for every curated entry', () => {
    for (const entry of REGISTRY) {
      const advice = adviceForServer(entry);
      expect(advice.message.length).toBeGreaterThan(20);
      expect(['recommended', 'official', 'community']).toContain(advice.kind);
    }
  });
});

describe('adviceForCli', () => {
  it('quotes a maintainer’s deprecation and points at the named replacement', () => {
    const advice = adviceForCli(cli({
      name: 'playwright-cli',
      package: 'playwright-cli',
      deprecated: 'This package is deprecated, use @playwright/cli instead.',
    }));
    expect(advice.kind).toBe('deprecated');
    expect(advice.message).toContain('use @playwright/cli instead');
    expect(advice.prefer?.name).toBe('@playwright/cli');
    expect(advice.prefer?.install).toBe('npm install -g @playwright/cli@latest');
  });

  it('recommends the curated Playwright CLI', () => {
    const advice = adviceForCli(cliCatalogEntry(knownCli('playwright-cli')!, 'win32'));
    expect(advice.kind).toBe('recommended');
    expect(advice.message).toContain('Microsoft');
  });

  it('accepts an npm scope as a publisher check', () => {
    const advice = adviceForCli(cli({ name: '@azure/some-cli', package: '@azure/some-cli' }));
    expect(advice.kind).toBe('official');
    expect(advice.message).toContain('@azure');
  });

  it('treats a Homebrew core formula as real but not vendor-endorsed', () => {
    const advice = adviceForCli(cli({ channel: 'brew', name: 'jq', homepage: 'https://jqlang.github.io/jq/' }));
    expect(advice.kind).toBe('official');
    expect(advice.message).toContain('Homebrew core');
  });

  it('redirects an unverified lookalike of a tool a vendor ships itself', () => {
    const advice = adviceForCli(cli({ name: 'playwright-runner-x', publisher: 'somebody', description: 'run playwright' }));
    expect(advice.kind).toBe('superseded');
    expect(advice.prefer?.entryId).toBe('playwright-cli');
  });

  it('says plainly when nothing can be established', () => {
    expect(adviceForCli(cli({ name: 'mystery-tool', publisher: 'nobody' })).kind).toBe('unverified');
  });
});

describe('officialAlternative', () => {
  it('matches on the service being named', () => {
    expect(officialAlternative('bridge for Linear issues')?.prefer.entryId).toBe('linear');
    expect(officialAlternative('a colour picker')).toBeUndefined();
  });

  it('matches a word-boundary mention it cannot tell from the real thing', () => {
    // Known limit of matching on words: "linear algebra" reads as Linear. It only
    // ever adds a suggestion to a result we already could not verify, so the cost
    // is a redundant line rather than a wrong config, and word boundaries keep the
    // obvious false friends ("delinearize") out.
    expect(officialAlternative('a linear algebra helper')?.prefer.entryId).toBe('linear');
    expect(officialAlternative('delinearize matrices')).toBeUndefined();
  });
});
