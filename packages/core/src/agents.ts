/**
 * Per-agent server permissions: the pure logic behind "may this agent use this
 * MCP server?" and the one-server-at-a-time flip the UI performs.
 *
 * An agent's scope is either `'*'` (every server, including ones added later) or
 * an explicit allow-list of server ids. The gateway enforces it (see
 * `createGateway`'s `allowServer`); this module owns the arithmetic so both the
 * daemon endpoint and its tests agree on the awkward cases.
 *
 * It also owns naming an agent and finding one again from a key that outlived
 * the exact id it was written against — see {@link matchAgents}.
 */

/** An agent's server scope: every server, or an explicit allow-list. */
export type ServerScope = '*' | string[];

/** Whether a scope permits one server id. */
export function isServerAllowed(scope: ServerScope, serverId: string): boolean {
  return scope === '*' || scope.includes(serverId);
}

/**
 * Enable or disable one server for one agent, returning the new scope.
 *
 * The interesting case is disabling a server on a `'*'` agent: "all servers"
 * cannot express "all but this one", so it is materialised into the list of
 * servers that exist right now, minus the one being turned off. That is a real
 * change in meaning (the agent stops auto-inheriting servers added later), so
 * the UI says so rather than letting it happen invisibly.
 *
 * Enabling never collapses a full list back to `'*'` for the same reason: the
 * two are not equivalent, and silently widening an agent's future access is the
 * wrong default for a permission control.
 *
 * @param allServerIds every configured server id, in display order, supplied by
 *   the caller (the daemon), because only it knows the full roster.
 */
export function setServerAllowed(
  scope: ServerScope,
  serverId: string,
  allowed: boolean,
  allServerIds: readonly string[],
): ServerScope {
  if (allowed) {
    if (scope === '*') return '*';
    return scope.includes(serverId) ? [...scope] : [...scope, serverId];
  }
  const current = scope === '*' ? [...allServerIds] : scope;
  return current.filter((id) => id !== serverId);
}

// ── naming and finding an agent ─────────────────────────────────────────────
//
// An agent's id is `${slug(name)}-${4 hex}`, so it is stable for as long as the
// agent is, and useless the moment someone deletes and re-adds it. Client
// configs written *against* that id (a `headersHelper` command, say) outlive it,
// so a key has to be able to find the agent that replaced the one it named.

/** The id stem minted from a display name: lowercase, dash-joined, bounded. */
export const agentSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'agent';

/** The display name a bare key implies: `claude-code` → `Claude Code`. */
export const agentNameFromKey = (key: string): string =>
  agentSlug(key)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Agent';

/** An id with its minted random suffix taken off again, when it has one. */
const idStem = (id: string): string => id.replace(/-[0-9a-f]{4}$/, '');

/**
 * Every agent a key could mean, most specific match first.
 *
 * Three tiers, and a tier only answers when the ones above it found nothing:
 * the exact id, then the display name (case- and punctuation-insensitive), then
 * the id stem — which is what makes `claude-code-a8ce` still resolve after the
 * agent it named was deleted and re-created as `claude-code-91f2`.
 *
 * Returns every match rather than picking one, because two agents called the
 * same thing is a question for the caller, not something to guess at when the
 * answer hands out a credential.
 */
export function matchAgents<T extends { id: string; name: string }>(agents: readonly T[], key: string): T[] {
  const wanted = key.trim();
  if (!wanted) return [];
  const exact = agents.filter((a) => a.id === wanted);
  if (exact.length) return exact;
  const slug = agentSlug(wanted);
  const byName = agents.filter((a) => agentSlug(a.name) === slug);
  if (byName.length) return byName;
  // Both sides lose the minted suffix, so a key that *is* a dead id
  // (`claude-code-a8ce`) and a key that is just the stem both land here.
  const stem = idStem(slug);
  return agents.filter((a) => idStem(a.id) === stem);
}

/** The one agent a key means, or `undefined` when it means none or several. */
export function resolveAgent<T extends { id: string; name: string }>(
  agents: readonly T[],
  key: string,
): T | undefined {
  const found = matchAgents(agents, key);
  return found.length === 1 ? found[0] : undefined;
}
