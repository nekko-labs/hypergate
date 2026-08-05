import type { Advice, AdvicePreference, CliCatalogEntry, RegistryEntry } from '@hypergate/shared';

/**
 * "Is this the right thing to add?" — the sentence that goes directly under a
 * search result.
 *
 * A search box that lists twenty things named `github` and says nothing about
 * them pushes the hardest decision (which of these is real?) onto the person
 * least able to answer it. Everything here turns a signal we can actually stand
 * behind into one plain sentence, and where the answer is "not this one", it
 * names what the provider recommends instead.
 *
 * The signals, and exactly how much each one proves:
 *
 * - **Curated flags.** Hand-set from vendor docs when the entry was added, which
 *   is the only source that can say "and this is the approach they point agents
 *   at". Strongest, and the reason the curated catalog exists.
 * - **A domain-verified reverse-DNS namespace** in the MCP registry
 *   (`com.atlassian/…`), which requires proving control of the domain ⇒
 *   first-party. `io.github.*` proves control of a GitHub account only.
 *   See `officialFromNamespace` in registry-search.ts.
 * - **An npm scope.** `@playwright/cli` can only be published by whoever owns the
 *   `@playwright` scope, so a scope we have tied to a vendor by hand is a real
 *   publisher check enforced by the registry, not a guess from the name.
 * - **A maintainer's own deprecation notice**, which usually names its own
 *   replacement ("use @playwright/cli instead") and is quoted rather than
 *   paraphrased.
 * - **Homebrew core**, a reviewed tap that builds from the upstream project's own
 *   release, so the formula being there means the tool is the real one — not that
 *   the vendor endorses installing it that way.
 *
 * Everything else is `unverified`, said plainly. Pure functions; no IO.
 */

/**
 * npm scopes tied to the vendor that owns them. Only scopes checked against the
 * vendor's own docs/repo belong here: the whole value of the list is that a
 * membership claim is verifiable, and one wrong row makes every row worthless.
 */
export const VENDOR_SCOPES: Record<string, string> = {
  '@playwright': 'Microsoft (Playwright)',
  '@modelcontextprotocol': 'the Model Context Protocol project',
  '@anthropic-ai': 'Anthropic',
  '@azure': 'Microsoft Azure',
  '@microsoft': 'Microsoft',
  '@cloudflare': 'Cloudflare',
  '@supabase': 'Supabase',
  '@vercel': 'Vercel',
  '@netlify': 'Netlify',
  '@google-cloud': 'Google Cloud',
  '@googleapis': 'Google',
  '@aws-sdk': 'AWS',
  '@openai': 'OpenAI',
  '@stripe': 'Stripe',
  '@sentry': 'Sentry',
  '@figma': 'Figma',
  '@linear': 'Linear',
  '@sanity': 'Sanity',
  '@shopify': 'Shopify',
  '@ionic': 'Ionic',
  '@angular': 'Angular (Google)',
  '@nestjs': 'NestJS',
  '@storybook': 'Storybook',
  '@types': 'DefinitelyTyped',
};

/** The vendor behind an npm scope, when we can name one. */
export const vendorForPackage = (pkg: string): string | undefined =>
  pkg.startsWith('@') ? VENDOR_SCOPES[pkg.split('/')[0]] : undefined;

/**
 * Where a provider's own recommendation differs from what a search turns up.
 * Each row is a service, the words a result about that service will carry, and
 * the path that service documents for agents. Applied only to results we could
 * *not* verify as first-party, so an official entry is never second-guessed.
 */
interface AlternativeRule {
  /** Matches a result's name, id, package or description. */
  match: RegExp;
  /** Why the provider's own path is better, in a clause that follows "…, but ". */
  reason: string;
  prefer: AdvicePreference;
}

export const OFFICIAL_ALTERNATIVES: AlternativeRule[] = [
  {
    match: /playwright/i,
    reason: 'Microsoft ships Playwright itself',
    prefer: {
      name: 'Playwright CLI (@playwright/cli)',
      entryId: 'playwright-cli',
      kind: 'cli',
      install: 'npm install -g @playwright/cli@latest',
      url: 'https://playwright.dev/agent-cli/introduction',
    },
  },
  {
    match: /\bgithub\b/i,
    reason: 'GitHub runs its own MCP server',
    prefer: { name: 'GitHub', entryId: 'github', kind: 'mcp', url: 'https://github.com/github/github-mcp-server' },
  },
  {
    match: /\bvercel\b/i,
    reason: 'Vercel hosts its own MCP server',
    prefer: { name: 'Vercel', entryId: 'vercel', kind: 'mcp', url: 'https://vercel.com/docs/agent-resources/vercel-mcp' },
  },
  {
    match: /\bsupabase\b/i,
    reason: 'Supabase hosts its own MCP server',
    prefer: { name: 'Supabase', entryId: 'supabase', kind: 'mcp', url: 'https://github.com/supabase/mcp' },
  },
  {
    match: /\blinear\b/i,
    reason: 'Linear hosts its own MCP server',
    prefer: { name: 'Linear', entryId: 'linear', kind: 'mcp', url: 'https://linear.app/docs/mcp' },
  },
  {
    match: /\bfigma\b/i,
    reason: 'Figma hosts its own MCP server',
    prefer: { name: 'Figma', entryId: 'figma', kind: 'mcp', url: 'https://developers.figma.com/docs/figma-mcp-server/' },
  },
  {
    match: /\bcloudflare\b/i,
    reason: 'Cloudflare runs its own MCP servers',
    prefer: { name: 'Cloudflare', entryId: 'cloudflare', kind: 'mcp', url: 'https://developers.cloudflare.com/agents/model-context-protocol/' },
  },
  {
    match: /\bcontext7\b/i,
    reason: 'Context7 hosts its own MCP server',
    prefer: { name: 'Context7', entryId: 'context7', kind: 'mcp', url: 'https://context7.com' },
  },
  {
    match: /\b(jira|confluence|atlassian)\b/i,
    reason: 'Atlassian runs its own remote MCP server',
    prefer: { name: 'Jira & Confluence', entryId: 'atlassian', kind: 'mcp', url: 'https://github.com/atlassian/atlassian-mcp-server' },
  },
  {
    match: /\bfly\.?io\b/i,
    reason: 'the Fly CLI ships an MCP server',
    prefer: { name: 'Fly.io', entryId: 'fly', kind: 'mcp', url: 'https://fly.io/docs/flyctl/mcp/' },
  },
];

/** The official path for a service named in this text, if there is one. */
export const officialAlternative = (text: string): AlternativeRule | undefined =>
  OFFICIAL_ALTERNATIVES.find((rule) => rule.match.test(text));

/**
 * The replacement out of a maintainer's deprecation notice. npm's convention is
 * a sentence naming the successor ("use @playwright/cli instead"), which is worth
 * far more than the fact of the deprecation on its own.
 */
export function preferredFromDeprecation(notice: string): string | undefined {
  const m = notice.match(/\buse\s+`?([@\w][\w./@^~-]*)`?\s+(?:package\s+)?instead/i)
    ?? notice.match(/\b(?:replaced|superseded)\s+by\s+`?([@\w][\w./@^~-]*)`?/i)
    ?? notice.match(/\bmoved\s+to\s+`?([@\w][\w./@^~-]*)`?/i);
  const name = m?.[1]?.replace(/[.,]$/, '');
  return name && name.length > 1 ? name : undefined;
}

/** Trim a notice to something that fits under a row without losing its meaning. */
const oneLine = (text: string, max = 220): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The verdict for one MCP catalog row (curated or a live registry hit). */
export function adviceForServer(entry: RegistryEntry): Advice {
  const vendor = entry.publisher;
  const haystack = `${entry.name} ${entry.id} ${entry.description ?? ''} ${entry.homepage ?? ''}`;

  if (entry.source !== 'registry') {
    // Curated: added by hand from the vendor's docs, so this is the one place
    // that can honestly say "and it's the way they recommend".
    //
    // A cross-kind alternative is *also* worth naming on an official entry — the
    // vendor sometimes ships both an MCP server and a CLI, and which one to reach
    // for depends on the harness (see the Playwright entries). Only cross-kind,
    // so an official MCP server is never told to consider itself.
    const sameVendorTool = officialAlternative(haystack);
    const alsoConsider = sameVendorTool?.prefer.kind && sameVendorTool.prefer.kind !== 'mcp' ? sameVendorTool.prefer : undefined;
    if (entry.recommended) {
      return {
        kind: 'recommended',
        message: `Recommended. ${entry.name}'s own server, and the connection Hypergate suggests starting with.`,
        prefer: alsoConsider,
      };
    }
    if (entry.official) {
      return {
        kind: 'official',
        message: `Official. This is ${entry.name}'s own server, configured the way its docs describe.`,
        prefer: alsoConsider,
      };
    }
    return {
      kind: 'community',
      message: `A community server for ${entry.name}, not published by the service itself. Read its source before you hand it credentials.`,
    };
  }

  if (entry.official === true) {
    return {
      kind: 'official',
      message: `Official. Published under the domain-verified namespace ${vendor ?? 'its own domain'}, which only the domain's owner can publish to.`,
    };
  }

  const alternative = officialAlternative(haystack);
  if (entry.official === false) {
    if (alternative) {
      return {
        kind: 'superseded',
        message: `Community server${vendor ? ` from ${vendor}` : ''}, and ${alternative.reason} — use the official one unless you need this implementation specifically.`,
        prefer: alternative.prefer,
      };
    }
    return {
      kind: 'community',
      message: `Community server${vendor ? ` published under ${vendor}` : ''}, not by the service it connects to. Read its source before you hand it credentials.`,
    };
  }

  return {
    kind: 'unverified',
    message: alternative
      ? `Hypergate can't verify who published this, and ${alternative.reason}.`
      : "Hypergate can't verify who published this. Check the source before adding it.",
    prefer: alternative?.prefer,
  };
}

/** The verdict for one CLI row (curated, or looked up on npm or Homebrew). */
export function adviceForCli(entry: CliCatalogEntry): Advice {
  const haystack = `${entry.name} ${entry.id} ${entry.package ?? ''} ${entry.description ?? ''}`;
  const alternative = officialAlternative(haystack);

  if (entry.deprecated) {
    const named = preferredFromDeprecation(entry.deprecated);
    return {
      kind: 'deprecated',
      message: `Deprecated by its maintainer: “${oneLine(entry.deprecated)}”`,
      prefer: named
        ? { name: named, kind: 'cli', install: `npm install -g ${named}@latest`, entryId: alternative?.prefer.entryId }
        : alternative?.prefer,
    };
  }

  if (entry.channel === 'curated') {
    if (entry.recommended) {
      return {
        kind: 'recommended',
        message: `Recommended. ${entry.publisher ? `${entry.publisher}'s own tool` : 'A first-party tool'}, and the one Hypergate suggests for this job.`,
      };
    }
    if (entry.official) {
      return { kind: 'official', message: `Official. Distributed by ${entry.publisher ?? 'the project itself'}; this is the install its docs describe.` };
    }
  }

  const vendor = entry.package ? vendorForPackage(entry.package) : undefined;
  if (vendor) {
    return {
      kind: 'official',
      message: `Official. Published to the ${entry.package?.split('/')[0]} npm scope, which only ${vendor} can publish to.`,
    };
  }

  if (entry.channel === 'brew') {
    return {
      kind: 'official',
      message: `In Homebrew core, built from ${entry.homepage ? 'the upstream project' : 'upstream'}'s own release. Homebrew reviews what goes in, though the project doesn't endorse this route specifically.`,
    };
  }

  if (alternative) {
    return {
      kind: 'superseded',
      message: `Unverified publisher${entry.publisher ? ` (${entry.publisher})` : ''}, and ${alternative.reason} — take the official route instead.`,
      prefer: alternative.prefer,
    };
  }

  return {
    kind: 'unverified',
    message: `Hypergate can't tie ${entry.publisher ? `${entry.publisher} ` : 'this publisher '}to the project it claims to be from. Check the repository before installing.`,
  };
}
