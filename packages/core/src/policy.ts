import type { ToolPolicy } from '@hypergate/shared';

/** Separator between a server id and a tool name (same as the gateway's). */
const NS = '__';

/** What a server says about one of its tools, as far as policy cares. */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export type ToolDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether a tool is read-only by its server's own declaration.
 *
 * MCP defaults `readOnlyHint` to false, so a tool that says nothing is not
 * read-only. That is the conservative reading and the one read-only mode needs:
 * the alternative would let every unannotated tool through a "read-only" agent.
 */
export const isReadOnly = (hints: ToolHints | undefined): boolean => hints?.readOnlyHint === true;

/** The inverse, for analytics: anything not declared read-only may change things. */
export const isDestructive = (hints: ToolHints | undefined): boolean => !isReadOnly(hints);

/**
 * May a caller with `policy` list or call `serverId`'s `tool`?
 *
 * Applied after the server allow-list, so it only ever narrows. `undefined`
 * policy = no tool-level limits, which is what every agent had before tool
 * permissions existed.
 */
export const toolAllowed = (
  policy: ToolPolicy | undefined,
  serverId: string,
  tool: string,
  hints: ToolHints | undefined,
): ToolDecision => {
  if (!policy) return { ok: true };
  const full = `${serverId}${NS}${tool}`;
  if (policy.blocked?.includes(full)) return { ok: false, reason: `tool "${full}" is blocked for this caller` };
  if (policy.readOnly && !isReadOnly(hints)) {
    return { ok: false, reason: `this caller is read-only and "${full}" is not declared read-only by its server` };
  }
  return { ok: true };
};

/**
 * Apply one change to a policy, returning a new one (or `undefined` when it has
 * become the no-limits default, so an untouched agent's record stays clean).
 */
export const updatePolicy = (
  policy: ToolPolicy | undefined,
  change: { readOnly?: boolean; tool?: string; allowed?: boolean },
): ToolPolicy | undefined => {
  const next: ToolPolicy = { ...(policy ?? {}) };
  if (typeof change.readOnly === 'boolean') next.readOnly = change.readOnly;
  if (change.tool && typeof change.allowed === 'boolean') {
    const blocked = new Set(next.blocked ?? []);
    if (change.allowed) blocked.delete(change.tool);
    else blocked.add(change.tool);
    next.blocked = [...blocked].sort();
  }
  if (!next.readOnly) delete next.readOnly;
  if (!next.blocked?.length) delete next.blocked;
  return Object.keys(next).length ? next : undefined;
};
