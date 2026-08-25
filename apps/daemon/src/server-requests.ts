import type { RegistryEntry, ServerInstallRequest } from '@hypergate/shared';

/**
 * Pending "please add this MCP server" requests: the same pattern as
 * `cli-requests.ts`, applied to servers. An agent may resolve anything it likes
 * and ask for it; only the user, in the manager, adds one. Filing requires
 * nothing (a request adds nothing); approving requires the master token plus a
 * same-origin request and is what actually creates the server.
 *
 * In memory for the same reasons the other two queues are: a request is worth
 * about as much as the attempt that produced it, the daemon outlives the retry
 * loop, and a restart just means the agent re-files. Deduped on
 * (agent, serverId), TTL'd, capped, oldest-first evicted.
 *
 * The row carries the *resolved* entry, not the query. Re-resolving at approval
 * time would mean the user approves one thing and Hypergate adds whatever the
 * registry says a few minutes later — a different version, or after an
 * ambiguous name gained a new match, a different server.
 */

const TTL_MS = 60 * 60 * 1000;
const MAX_PENDING = 50;

const keyOf = (agentId: string, serverId: string): string => `${agentId} ${serverId}`;

export class ServerInstallRequestStore {
  private rows = new Map<string, ServerInstallRequest>();
  private seq = 0;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private prune(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [key, row] of this.rows) {
      if (Date.parse(row.askedAt) < cutoff) this.rows.delete(key);
    }
  }

  file(input: {
    query: string;
    serverName: string;
    entry: RegistryEntry;
    version?: string;
    summary: string;
    outstanding: string[];
    agentId: string;
    agentName: string;
    reason?: string;
  }): ServerInstallRequest {
    this.prune();
    const key = keyOf(input.agentId, input.entry.id);
    const existing = this.rows.get(key);
    if (existing) {
      existing.attempts += 1;
      if (input.reason?.trim()) existing.reason = input.reason.trim();
      // Refresh what would be added: the agent may be re-asking precisely
      // because a newer version has shipped since the first attempt.
      existing.entry = input.entry;
      existing.version = input.version;
      existing.summary = input.summary;
      existing.outstanding = input.outstanding;
      return { ...existing };
    }
    if (this.rows.size >= MAX_PENDING) {
      const oldest = [...this.rows.entries()].sort((a, b) => Date.parse(a[1].askedAt) - Date.parse(b[1].askedAt))[0];
      if (oldest) this.rows.delete(oldest[0]);
    }
    this.seq += 1;
    const row: ServerInstallRequest = {
      id: `srv-req-${this.seq}`,
      agentId: input.agentId,
      agentName: input.agentName,
      query: input.query,
      serverName: input.serverName,
      serverId: input.entry.id,
      displayName: input.entry.name,
      version: input.version,
      summary: input.summary,
      entry: input.entry,
      outstanding: input.outstanding,
      reason: input.reason?.trim() || undefined,
      askedAt: new Date(this.now()).toISOString(),
      attempts: 1,
    };
    this.rows.set(key, row);
    return { ...row };
  }

  list(): ServerInstallRequest[] {
    this.prune();
    return [...this.rows.values()]
      .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt))
      .map((r) => ({ ...r }));
  }

  get(id: string): ServerInstallRequest | undefined {
    this.prune();
    const row = [...this.rows.values()].find((r) => r.id === id);
    return row ? { ...row } : undefined;
  }

  count(): number {
    this.prune();
    return this.rows.size;
  }

  /** Remove one request, however it was answered. Returns what it was. */
  resolve(id: string): ServerInstallRequest | undefined {
    this.prune();
    for (const [key, row] of this.rows) {
      if (row.id === id) {
        this.rows.delete(key);
        return { ...row };
      }
    }
    return undefined;
  }

  /** Drop every request from a deleted agent. */
  forgetAgent(agentId: string): void {
    for (const [key, row] of this.rows) {
      if (row.agentId === agentId) this.rows.delete(key);
    }
  }
}
