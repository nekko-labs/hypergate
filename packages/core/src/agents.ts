/**
 * Per-agent server permissions: the pure logic behind "may this agent use this
 * MCP server?" and the one-server-at-a-time flip the UI performs.
 *
 * An agent's scope is either `'*'` (every server, including ones added later) or
 * an explicit allow-list of server ids. The gateway enforces it (see
 * `createGateway`'s `allowServer`); this module owns the arithmetic so both the
 * daemon endpoint and its tests agree on the awkward cases.
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
