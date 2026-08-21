import type { CredentialMeta } from '@hypergate/shared';
import { isServerAllowed, setServerAllowed, agentSlug } from './agents.js';
import { guideForService } from './credential-catalog.js';

/**
 * The credential vault's pure half: the allow-list arithmetic for agents, and
 * the env-shaping used by spawn injection, the gateway tools, and
 * `hypergate run`.
 *
 * The guides ("where does this key come from") were here too until the list
 * outgrew the file; they now live in `credential-catalog.ts` and are
 * re-exported at the bottom, so this file stays small enough to read in one
 * sitting while the data can grow a provider at a time.
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
 * The guides themselves live in `credential-catalog.ts`: this file is the
 * vault's logic, that one is its data. Re-exported here so every daemon-side
 * caller keeps a single import surface.
 */
export {
  CREDENTIAL_GUIDES,
  guideForService,
  guideForCli,
  guidesForServer,
  guidesInCategory,
  searchGuides,
} from './credential-catalog.js';

/**
 * The env a credential's value should be injected as: its own env var, plus the
 * guide's aliases when the credential was created from a guide. No env var, no
 * injection: a credential without one is fetchable by id but never ambient.
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
