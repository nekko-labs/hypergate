import { describe, it, expect } from 'vitest';
import { CREDENTIAL_CATEGORIES } from '@hypergate/shared';
import {
  CREDENTIAL_GUIDES,
  guideForCli,
  guideForService,
  guidesForServer,
  guidesInCategory,
  searchGuides,
} from './credential-catalog.js';

/**
 * The catalog's promise is that clicking "Get it" lands on the vendor's own
 * page that mints the key. Nothing in a unit test can check that a URL still
 * resolves, so these cover the failure modes that *are* mechanical: a
 * duplicated service, two guides fighting over one env var, an entry with
 * nowhere to send the user, and a link that is not the vendor's.
 */
describe('the credential catalog', () => {
  it('has one entry per service', () => {
    const services = CREDENTIAL_GUIDES.map((g) => g.service);
    expect(new Set(services).size).toBe(services.length);
  });

  it('never has two guides claiming the same env var', () => {
    // Two guides injecting the same variable would make which key a server got
    // depend on catalog order, which is not something anyone should have to know.
    const seen = new Map<string, string>();
    for (const g of CREDENTIAL_GUIDES) {
      const clash = seen.get(g.envVar);
      expect(clash, `${g.service} and ${clash} both claim ${g.envVar}`).toBeUndefined();
      seen.set(g.envVar, g.service);
    }
  });

  it('never has an alias that is another guide\'s canonical env var', () => {
    // An alias is injected alongside the canonical name, so one guide aliasing
    // another's primary var would silently overwrite a different key's value.
    const canonical = new Map(CREDENTIAL_GUIDES.map((g) => [g.envVar, g.service]));
    for (const g of CREDENTIAL_GUIDES) {
      for (const alias of g.aliases ?? []) {
        const owner = canonical.get(alias);
        expect(owner === undefined || owner === g.service, `${g.service} aliases ${alias}, owned by ${owner}`).toBe(
          true,
        );
      }
    }
  });

  it('gives every entry a way to actually get the key', () => {
    // An entry with neither a page nor a command is worse than no entry: it
    // claims guidance and delivers a name.
    for (const g of CREDENTIAL_GUIDES) {
      expect(Boolean(g.createUrl || g.createCommand), `${g.service} has no createUrl and no createCommand`).toBe(true);
    }
  });

  it('only ever links https, and never a shortener or a third party', () => {
    for (const g of CREDENTIAL_GUIDES) {
      for (const url of [g.createUrl, g.manageUrl, g.docsUrl].filter(Boolean) as string[]) {
        expect(url.startsWith('https://'), `${g.service}: ${url} is not https`).toBe(true);
        // The trust rule, mechanised as far as it can be: these hosts are where
        // a copied-from-a-blog-post link would come from.
        for (const bad of ['bit.ly', 'tinyurl', 'medium.com', 'dev.to', 'stackoverflow']) {
          expect(url.includes(bad), `${g.service}: ${url} is not first-party`).toBe(false);
        }
      }
    }
  });

  it('gives every entry a valid env var name and a known category', () => {
    const categories = new Set(CREDENTIAL_CATEGORIES.map((c) => c.id));
    for (const g of CREDENTIAL_GUIDES) {
      expect(g.envVar, `${g.service}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(categories.has(g.category), `${g.service} has category ${g.category}`).toBe(true);
    }
  });

  it('covers every category it declares', () => {
    // A heading with nothing under it renders as a dead row in the add panel.
    for (const cat of CREDENTIAL_CATEGORIES) {
      expect(guidesInCategory(cat.id).length, `category ${cat.id} is empty`).toBeGreaterThan(0);
    }
  });

  it('keeps the v1.7.0 services, so an upgrade loses nothing', () => {
    // These eight shipped in v1.7.0 and may already be stored, referenced by a
    // server, or granted to an agent. Dropping one would orphan those.
    for (const service of ['github', 'fly', 'vercel', 'cloudflare', 'supabase', 'npm', 'anthropic', 'openai']) {
      expect(guideForService(service), service).toBeDefined();
    }
  });

  it('looks a service up case-insensitively and with stray whitespace', () => {
    expect(guideForService('  GitHub ')?.service).toBe('github');
    expect(guideForService('nope')).toBeUndefined();
  });

  it('finds the guide behind a CLI and a catalog server', () => {
    expect(guideForCli('gh')?.service).toBe('github');
    expect(guideForCli('flyctl')?.service).toBe('fly');
    expect(guidesForServer('github').map((g) => g.service)).toContain('github');
    expect(guideForCli('not-a-cli')).toBeUndefined();
  });
});

describe('searching the guides', () => {
  it('finds a provider by the three things a user might know', () => {
    // The product, the command that just failed, and the variable an error
    // message named. All three have to reach the same row.
    for (const query of ['fly', 'flyctl', 'FLY_API_TOKEN']) {
      expect(searchGuides(query, CREDENTIAL_GUIDES)[0]?.service, query).toBe('fly');
    }
  });

  it('ranks an exact env var above a mere substring', () => {
    // GH_TOKEN is GitHub's canonical var; several other guides mention "token"
    // in their name, and they must not outrank it.
    expect(searchGuides('GH_TOKEN', CREDENTIAL_GUIDES)[0]?.service).toBe('github');
  });

  it('puts the prefix match first for an ambiguous stem', () => {
    // "git" is a prefix of github and gitlab and a substring of neither's env
    // var, so both must come back, github first (catalog order breaks the tie).
    const hits = searchGuides('git', CREDENTIAL_GUIDES).map((g) => g.service);
    expect(hits.slice(0, 2)).toEqual(['github', 'gitlab']);
  });

  it('finds a guide by an alias, not just its canonical name', () => {
    expect(searchGuides('GITHUB_PERSONAL_ACCESS_TOKEN', CREDENTIAL_GUIDES)[0]?.service).toBe('github');
    expect(searchGuides('JIRA_API_TOKEN', CREDENTIAL_GUIDES)[0]?.service).toBe('atlassian');
  });

  it('treats a multi-word query as a narrowing, not a union', () => {
    // The bug this guards: scoring each term and summing would return every
    // guide that mentions "token" as well as the Fly one.
    const hits = searchGuides('fly token', CREDENTIAL_GUIDES);
    expect(hits.map((g) => g.service)).toEqual(['fly']);
  });

  it('returns nothing for a provider that is not in the catalog', () => {
    // Must be empty rather than everything: the empty result is what shows the
    // "store this as your own" escape hatch.
    expect(searchGuides('hooli', CREDENTIAL_GUIDES)).toEqual([]);
    expect(searchGuides('clerk', CREDENTIAL_GUIDES)).toEqual([]);
  });

  it('returns the whole catalog in order for an empty query', () => {
    for (const query of ['', '   ']) {
      expect(searchGuides(query, CREDENTIAL_GUIDES)).toEqual(CREDENTIAL_GUIDES);
    }
  });

  it('is case-insensitive', () => {
    expect(searchGuides('STRIPE', CREDENTIAL_GUIDES)[0]?.service).toBe('stripe');
    expect(searchGuides('sTrIpE', CREDENTIAL_GUIDES)[0]?.service).toBe('stripe');
  });

  it('survives a query made entirely of regex metacharacters', () => {
    // The word-boundary tier builds a RegExp from the term, so an unescaped
    // query like "c++" or "(" would throw rather than return nothing.
    for (const query of ['c++', '(', '[a-z', '*', '\\']) {
      expect(() => searchGuides(query, CREDENTIAL_GUIDES)).not.toThrow();
    }
  });
});
