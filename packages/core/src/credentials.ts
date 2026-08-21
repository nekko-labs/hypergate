import type { CredentialGuide, CredentialMeta } from '@hypergate/shared';
import { isServerAllowed, setServerAllowed, agentSlug } from './agents.js';

/**
 * The credential vault's pure half: the curated guides ("where does this key
 * come from"), the allow-list arithmetic for agents, and the env-shaping used
 * by spawn injection, the gateway tools, and `hypergate run`.
 *
 * The guides follow the catalog's trust rule: every URL and command is the
 * vendor's own, and a service is only listed when there is a real first-party
 * token page or command to send the user to. No guide is required to store a
 * credential — a custom name + env var is always enough.
 */

/** An agent's credential scope. Absent means none: keys are deny-by-default. */
export type CredentialScope = '*' | string[] | undefined;

/** Whether a scope permits fetching one credential. Absent scope permits nothing. */
export function isCredentialAllowed(scope: CredentialScope, credentialId: string): boolean {
  if (scope === undefined) return false;
  return isServerAllowed(scope, credentialId);
}

/**
 * Enable or disable one credential for one agent. Same arithmetic as the
 * per-server flip (including the `'*'`-pinning rule), with one difference at
 * the edge: an absent scope is an empty list, so the first grant produces
 * `[id]`, never `'*'`.
 */
export function setCredentialAllowed(
  scope: CredentialScope,
  credentialId: string,
  allowed: boolean,
  allCredentialIds: readonly string[],
): '*' | string[] {
  return setServerAllowed(scope ?? [], credentialId, allowed, allCredentialIds);
}

/** The id stem minted from a credential's name: same rules as agent ids. */
export const credentialSlug = agentSlug;

/**
 * Enough of a secret to recognise it, never enough to use it. Mirrors the OAuth
 * app's client-id masking: the API returning anything longer would make it a
 * way to read a key back out of the keychain.
 */
export const maskSecret = (value: string): string =>
  value.length <= 10 ? `${value.slice(0, 2)}…` : `${value.slice(0, 4)}…${value.slice(-4)}`;

// The env var/secret heuristics live in @hypergate/shared (the browser needs
// them without bundling core); re-exported here so daemon-side callers keep
// one import surface.
export { isValidEnvVar, looksSecret } from '@hypergate/shared';

/**
 * Curated guides. Each entry claims only what the vendor's own docs state:
 * the create page/command, the manage page, and which curated CLIs/servers
 * the credential authenticates.
 */
export const CREDENTIAL_GUIDES: CredentialGuide[] = [
  {
    service: 'github',
    name: 'GitHub personal access token',
    kind: 'token',
    envVar: 'GH_TOKEN',
    aliases: ['GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN'],
    createUrl: 'https://github.com/settings/personal-access-tokens',
    manageUrl: 'https://github.com/settings/tokens',
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    clis: ['gh'],
    servers: ['github'],
    note: 'Fine-grained tokens can be scoped to single repositories; the gh CLI reads GH_TOKEN.',
  },
  {
    service: 'fly',
    name: 'Fly.io API token',
    kind: 'token',
    envVar: 'FLY_API_TOKEN',
    createUrl: 'https://fly.io/user/personal_access_tokens',
    createCommand: 'flyctl tokens create org',
    manageUrl: 'https://fly.io/user/personal_access_tokens',
    docsUrl: 'https://fly.io/docs/security/tokens/',
    clis: ['flyctl'],
    servers: ['fly'],
    note: 'Prefer a scoped deploy or org token over the account-wide one flyctl auth token prints.',
  },
  {
    service: 'vercel',
    name: 'Vercel access token',
    kind: 'token',
    envVar: 'VERCEL_TOKEN',
    createUrl: 'https://vercel.com/account/tokens',
    manageUrl: 'https://vercel.com/account/tokens',
    docsUrl: 'https://vercel.com/docs/rest-api#authentication',
    clis: ['vercel'],
    note: 'The hosted Vercel MCP server signs in with OAuth instead; this token is for the CLI and REST API.',
  },
  {
    service: 'cloudflare',
    name: 'Cloudflare API token',
    kind: 'token',
    envVar: 'CLOUDFLARE_API_TOKEN',
    createUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    manageUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
    clis: ['wrangler'],
    note: 'Create a scoped token from a template; the global API key is the account-wide fallback to avoid.',
  },
  {
    service: 'supabase',
    name: 'Supabase access token',
    kind: 'token',
    envVar: 'SUPABASE_ACCESS_TOKEN',
    createUrl: 'https://supabase.com/dashboard/account/tokens',
    manageUrl: 'https://supabase.com/dashboard/account/tokens',
    clis: ['supabase'],
    note: 'The hosted Supabase MCP server signs in with OAuth; this token authenticates the CLI.',
  },
  {
    service: 'npm',
    name: 'npm access token',
    kind: 'token',
    envVar: 'NPM_TOKEN',
    createCommand: 'npm token create',
    docsUrl: 'https://docs.npmjs.com/creating-and-viewing-access-tokens',
    clis: ['npm'],
    note: 'Granular tokens (scoped, expiring) come from the npmjs.com token page; npm token create mints a classic one.',
  },
  {
    service: 'anthropic',
    name: 'Anthropic API key',
    kind: 'api-key',
    envVar: 'ANTHROPIC_API_KEY',
    createUrl: 'https://console.anthropic.com/settings/keys',
    manageUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/api/getting-started',
    clis: ['claude'],
  },
  {
    service: 'openai',
    name: 'OpenAI API key',
    kind: 'api-key',
    envVar: 'OPENAI_API_KEY',
    createUrl: 'https://platform.openai.com/api-keys',
    manageUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference/authentication',
  },
];

export const guideForService = (service: string): CredentialGuide | undefined =>
  CREDENTIAL_GUIDES.find((g) => g.service === service.trim().toLowerCase());

/** The guide whose credential authenticates a curated CLI (`gh` → github). */
export const guideForCli = (cliId: string): CredentialGuide | undefined =>
  CREDENTIAL_GUIDES.find((g) => g.clis?.includes(cliId));

/** Guides whose credential can supply a curated catalog server's `requires`. */
export const guidesForServer = (serverId: string): CredentialGuide[] =>
  CREDENTIAL_GUIDES.filter((g) => g.servers?.includes(serverId));

/**
 * The env a credential's value should be injected as: its own env var, plus the
 * guide's aliases when the credential was created from a guide. No env var, no
 * injection — a credential without one is fetchable by id but never ambient.
 */
export function credentialEnv(meta: Pick<CredentialMeta, 'service' | 'envVar'>, value: string): Record<string, string> {
  if (!meta.envVar) return {};
  const env: Record<string, string> = { [meta.envVar]: value };
  const guide = meta.service ? guideForService(meta.service) : undefined;
  // Aliases only apply when the credential still answers to the guide's
  // canonical var; a hand-renamed env var means the user chose the name.
  if (guide && guide.envVar === meta.envVar) {
    for (const alias of guide.aliases ?? []) env[alias] = value;
  }
  return env;
}
