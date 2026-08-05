import type { CliCatalogEntry, CliInstallOption } from '@hypergate/shared';
import { cliCatalogEntry, KNOWN_CLIS, matchesCli, sortCliCatalog } from './clis.js';

/**
 * Looking up a command-line tool you could install — the CLI half of the catalog.
 *
 * ## Why these two sources
 *
 * There is no single official registry of command-line tools, so "the best
 * official resource" is really "the authoritative index for each way a CLI is
 * actually distributed". Two of them are public, keyless, and carry the metadata
 * needed to tell a first-party tool from a lookalike:
 *
 * 1. **The npm registry** (`registry.npmjs.org`) — authoritative for the channel
 *    Hypergate can always install from, since Node is already a hard requirement
 *    of the product. Every record states the `bin` map (which is what makes a
 *    package a CLI rather than a library), the publisher, the repository, and the
 *    maintainer's own `deprecated` notice. Crucially, a **scope** like
 *    `@playwright` can only be published to by its owner, so a scope tied to a
 *    vendor is a publisher check the registry enforces (see advice.ts).
 * 2. **Homebrew's formulae API** (`formulae.brew.sh/api`) — the largest curated,
 *    officially maintained catalog of native CLIs (jq, ripgrep, awscli), built
 *    from each project's own upstream release, and the only one of these sources
 *    that publishes real install counts (`analytics.install.30d`).
 *
 * Deliberately not used: winget (no documented public search API — the endpoint
 * its client uses is undocumented Store infrastructure), Scoop and Chocolatey
 * (community buckets with no first-party guarantee), and asdf/mise (plugin lists,
 * not tool catalogs). Windows install commands are therefore hand-written on the
 * curated entries rather than looked up.
 *
 * Same rules as the MCP registry search: only on an explicit user search, never
 * on boot, bounded, and soft-failing. `fetchImpl` is injectable so every mapper
 * is unit-tested against canned JSON with no network.
 */

const NPM_BASE = 'https://registry.npmjs.org';
const BREW_BASE = 'https://formulae.brew.sh/api';

/** Only ever used for a URL path segment against a package/formula index. */
const SAFE_NAME = /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i;

interface NpmSearchResponse {
  objects?: { package?: { name?: string; description?: string; keywords?: string[]; publisher?: { username?: string }; links?: Record<string, string> } }[];
}

/** The fields we read out of a package's `latest` manifest. */
interface NpmManifest {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  homepage?: string;
  deprecated?: string;
  bin?: string | Record<string, string>;
  repository?: string | { url?: string };
  author?: string | { name?: string };
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cli';

/** The command a package installs, from its `bin` map. */
export function binCommand(manifest: NpmManifest): string | undefined {
  const { bin, name } = manifest;
  if (typeof bin === 'string') return (name ?? '').split('/').pop() || undefined;
  const keys = Object.keys(bin ?? {});
  if (keys.length === 0) return undefined;
  // A package with several bins usually has one named after itself; otherwise the
  // first is the entry point its docs lead with.
  const own = (name ?? '').split('/').pop();
  return own && keys.includes(own) ? own : keys[0];
}

const repoUrl = (manifest: NpmManifest): string | undefined => {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  return raw?.replace(/^git\+/, '').replace(/\.git$/, '');
};

/**
 * Who to name as the publisher.
 *
 * npm's search index reports the account that *pushed* the release, which for
 * anything with CI is literally "GitHub Actions" — true, and no help at all to
 * someone deciding whether a package is Microsoft's. The repository owner is the
 * more useful answer and the one a person would go and check, so it wins when
 * there is one.
 */
export function publisherOf(manifest: NpmManifest, npmPublisher?: string): string | undefined {
  const owner = repoUrl(manifest)?.match(/github\.com[/:]([^/]+)/i)?.[1];
  if (owner) return `${owner} on GitHub`;
  if (npmPublisher && !/^github[ -]?actions$/i.test(npmPublisher)) return npmPublisher;
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
  return author;
}

/** How to categorise a looked-up tool, from the words it describes itself with. */
export function categoryFor(text: string): string {
  const t = text.toLowerCase();
  if (/\bmcp\b|model context protocol/.test(t)) return 'mcp';
  if (/browser|playwright|puppeteer|selenium|e2e|test/.test(t)) return 'testing';
  if (/docker|container|kubernetes|podman/.test(t)) return 'container';
  if (/aws|azure|gcp|google cloud|cloudflare|vercel|netlify|fly\.io|deploy|serverless/.test(t)) return 'cloud';
  if (/git\b|version control|repository/.test(t)) return 'vcs';
  if (/package manager|installer|registry/.test(t)) return 'package';
  if (/runtime|interpreter|compiler/.test(t)) return 'runtime';
  return 'other';
}

/** Map one npm manifest (plus its search-result metadata) to a catalog entry. */
export function mapNpmCli(
  manifest: NpmManifest,
  meta: { publisher?: string; description?: string; links?: Record<string, string> } = {},
): CliCatalogEntry | undefined {
  const pkg = manifest.name;
  const command = binCommand(manifest);
  if (!pkg || !command) return undefined; // no executable ⇒ not a CLI

  const description = manifest.description ?? meta.description ?? '';
  const installs: CliInstallOption[] = [{ label: 'npm', command: `npm install -g ${pkg}@latest` }];
  return {
    id: `npm:${slug(pkg)}`,
    name: pkg,
    command,
    description,
    category: categoryFor(`${pkg} ${description} ${(manifest.keywords ?? []).join(' ')}`),
    channel: 'npm',
    package: pkg,
    latest: manifest.version,
    deprecated: manifest.deprecated,
    homepage: manifest.homepage ?? meta.links?.homepage ?? repoUrl(manifest),
    publisher: publisherOf(manifest, meta.publisher),
    installs,
    install: installs[0].command,
  };
}

/** Shape of a `formulae.brew.sh/api/formula/<name>.json` document (fields we read). */
interface BrewFormula {
  name?: string;
  full_name?: string;
  desc?: string;
  homepage?: string;
  license?: string;
  deprecated?: boolean;
  deprecation_reason?: string;
  disabled?: boolean;
  versions?: { stable?: string };
  analytics?: { install?: Record<string, Record<string, number>> };
}

/** Map one Homebrew formula to a catalog entry. */
export function mapBrewFormula(formula: BrewFormula): CliCatalogEntry | undefined {
  const name = formula.name ?? formula.full_name;
  if (!name) return undefined;
  const installs: CliInstallOption[] = [{ label: 'Homebrew', command: `brew install ${name}`, platforms: ['darwin', 'linux'] }];
  const thirtyDay = formula.analytics?.install?.['30d'];
  const popularity = thirtyDay ? Math.max(...Object.values(thirtyDay).filter((n) => typeof n === 'number'), 0) : undefined;
  return {
    id: `brew:${slug(name)}`,
    name,
    command: name,
    description: formula.desc ?? '',
    category: categoryFor(`${name} ${formula.desc ?? ''}`),
    channel: 'brew',
    package: name,
    latest: formula.versions?.stable,
    homepage: formula.homepage,
    publisher: 'Homebrew core',
    popularity: popularity || undefined,
    deprecated: formula.disabled
      ? `Disabled in Homebrew${formula.deprecation_reason ? `: ${formula.deprecation_reason}` : '.'}`
      : formula.deprecated
        ? `Deprecated in Homebrew${formula.deprecation_reason ? `: ${formula.deprecation_reason}` : '.'}`
        : undefined,
    installs,
    install: installs[0].command,
  };
}

/** Search npm for installable CLIs matching a query. Never throws for one bad package. */
export async function searchNpmClis(
  query: string,
  opts: { limit?: number; base?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CliCatalogEntry[]> {
  const { limit = 6, base = NPM_BASE, fetchImpl = fetch, signal } = opts;
  const text = query.trim();
  if (!text) return [];

  const url = new URL('/-/v1/search', base);
  url.searchParams.set('text', text);
  // Over-fetch: libraries outnumber CLIs, and a package only earns a row once its
  // manifest proves it installs a command.
  url.searchParams.set('size', String(Math.min(20, limit * 3)));
  const res = await fetchImpl(url.toString(), { signal, headers: { accept: 'application/json', 'user-agent': 'hypergate' } });
  if (!res.ok) throw new Error(`npm search ${res.status}`);
  const data = (await res.json()) as NpmSearchResponse;

  const candidates = (data.objects ?? [])
    .map((o) => o.package)
    .filter((p): p is NonNullable<typeof p> => !!p?.name && SAFE_NAME.test(p.name));

  const manifests = await Promise.all(
    candidates.map(async (p) => {
      try {
        const m = await fetchImpl(`${base}/${p.name!.replace('/', '%2f')}/latest`, {
          signal,
          headers: { accept: 'application/json', 'user-agent': 'hypergate' },
        });
        if (!m.ok) return undefined;
        return mapNpmCli((await m.json()) as NpmManifest, {
          publisher: p.publisher?.username,
          description: p.description,
          links: p.links,
        });
      } catch {
        return undefined; // one unreachable manifest must not empty the whole search
      }
    }),
  );
  // npm returns relevance order and we keep it: it is the registry's own answer to
  // "which of these did you mean", and inventing a score on top of it would only
  // move the official package away from the top, which is where it belongs.
  return manifests.filter((e): e is CliCatalogEntry => !!e).slice(0, limit);
}

/** Look up one Homebrew formula by exact name (the API has no search endpoint). */
export async function lookupBrewFormula(
  name: string,
  opts: { base?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CliCatalogEntry | undefined> {
  const { base = BREW_BASE, fetchImpl = fetch, signal } = opts;
  const formula = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(formula)) return undefined;
  const res = await fetchImpl(`${base}/formula/${formula}.json`, {
    signal,
    headers: { accept: 'application/json', 'user-agent': 'hypergate' },
  });
  // A missing formula answers with the site's HTML 404 page, so the content type
  // is the check that matters, not just the status.
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
  return mapBrewFormula((await res.json()) as BrewFormula);
}

/** The curated tools matching a query, as catalog entries for this platform. */
export function searchCuratedClis(query: string, platform?: string): CliCatalogEntry[] {
  return KNOWN_CLIS.filter((c) => matchesCli(c, query)).map((c) => cliCatalogEntry(c, platform));
}

/**
 * The whole lookup: curated first (hand-verified, and the only source that can
 * say "recommended"), then npm, then the Homebrew formula of that exact name.
 * De-duplicated by package and by command, so the official `@playwright/cli` row
 * doesn't appear twice because it is both curated and on npm.
 */
export async function searchCliCatalog(
  query: string,
  opts: { limit?: number; fetchImpl?: typeof fetch; signal?: AbortSignal; npmBase?: string; brewBase?: string; platform?: string } = {},
): Promise<CliCatalogEntry[]> {
  const { limit = 6, fetchImpl, signal, npmBase, brewBase, platform } = opts;
  const text = query.trim();
  if (!text) return [];

  const curated = searchCuratedClis(text, platform);
  const [npm, brew] = await Promise.all([
    searchNpmClis(text, { limit, fetchImpl, signal, base: npmBase }).catch(() => []),
    lookupBrewFormula(text, { fetchImpl, signal, base: brewBase }).catch(() => undefined),
  ]);

  const packages = new Set<string>();
  const commands = new Set<string>();
  const out: CliCatalogEntry[] = [];
  for (const entry of [...curated, ...npm, ...(brew ? [brew] : [])]) {
    const pkg = entry.package?.toLowerCase();
    const command = entry.command.toLowerCase();
    if ((pkg && packages.has(pkg)) || commands.has(command)) continue;
    if (pkg) packages.add(pkg);
    commands.add(command);
    out.push(entry);
  }
  return sortCliCatalog(out);
}
