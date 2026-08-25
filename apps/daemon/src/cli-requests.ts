import type { CliChannel, CliInstallRequest } from '@hypergate/shared';

/**
 * Pending CLI install requests: the credential-request pattern (requests.ts)
 * applied to tools. An agent may see what is installed and ask for what isn't;
 * only the user, in the manager, runs the install. Filing requires nothing (a
 * request installs nothing); approving requires the master token plus a
 * same-origin request and is what actually starts the job.
 *
 * In memory for the same reasons the credential store is: a request is worth
 * about as much as the attempt that produced it, the daemon outlives the retry
 * loop, and a restart just means the agent re-files. Deduped on
 * (agent, tool), TTL'd, capped, oldest-first evicted.
 */

const TTL_MS = 60 * 60 * 1000;
const MAX_PENDING = 50;

const keyOf = (agentId: string, cliId: string): string => `${agentId} ${cliId}`;

export class CliInstallRequestStore {
  private rows = new Map<string, CliInstallRequest>();
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
    cliId: string;
    cliName: string;
    channel?: CliChannel;
    package?: string;
    agentId: string;
    agentName: string;
    reason?: string;
  }): CliInstallRequest {
    this.prune();
    const key = keyOf(input.agentId, input.cliId);
    const existing = this.rows.get(key);
    if (existing) {
      existing.attempts += 1;
      if (input.reason?.trim()) existing.reason = input.reason.trim();
      return { ...existing };
    }
    if (this.rows.size >= MAX_PENDING) {
      const oldest = [...this.rows.entries()].sort((a, b) => Date.parse(a[1].askedAt) - Date.parse(b[1].askedAt))[0];
      if (oldest) this.rows.delete(oldest[0]);
    }
    this.seq += 1;
    const row: CliInstallRequest = {
      id: `cli-req-${this.seq}`,
      cliId: input.cliId,
      cliName: input.cliName,
      channel: input.channel,
      package: input.package,
      agentId: input.agentId,
      agentName: input.agentName,
      reason: input.reason?.trim() || undefined,
      askedAt: new Date(this.now()).toISOString(),
      attempts: 1,
    };
    this.rows.set(key, row);
    return { ...row };
  }

  list(): CliInstallRequest[] {
    this.prune();
    return [...this.rows.values()]
      .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt))
      .map((r) => ({ ...r }));
  }

  get(id: string): CliInstallRequest | undefined {
    this.prune();
    const row = [...this.rows.values()].find((r) => r.id === id);
    return row ? { ...row } : undefined;
  }

  count(): number {
    this.prune();
    return this.rows.size;
  }

  /** Remove one request, however it was answered. Returns what it was. */
  resolve(id: string): CliInstallRequest | undefined {
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
