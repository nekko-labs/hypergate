import type { Insight, UsageEvent } from '@hypergate/shared';

/**
 * Turn the audit log into the few things a person should look at.
 *
 * Fixed rules, no model: each insight names the rule that raised it, so it can
 * be checked against the raw calls it came from. A model (the user's own agent,
 * through `hypergate__audit_review`) can read these and the log and explain
 * them; this function only decides what is worth reading.
 */

export const BURST_CALLS = 60;
export const BURST_WINDOW_MS = 60_000;
export const PROBE_THRESHOLD = 5;
export const ERROR_SPIKE_MIN_CALLS = 10;
export const ERROR_SPIKE_RATIO = 0.5;

export interface InsightOptions {
  /** Defaults to now. */
  now?: number;
  /** How far back to look. Defaults to 24 hours. */
  windowHours?: number;
  /**
   * Every event before the window, or at least enough to know which callers and
   * which (caller, tool) destructive pairs were already seen. Without it every
   * caller in the window looks new.
   */
  history?: UsageEvent[];
}

const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;

export const computeInsights = (events: UsageEvent[], opts: InsightOptions = {}): Insight[] => {
  const now = opts.now ?? Date.now();
  const since = now - (opts.windowHours ?? 24) * 3_600_000;
  const inWindow = events
    .filter((e) => {
      const t = Date.parse(e.at);
      return t >= since && t <= now;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const before = [...(opts.history ?? []), ...events.filter((e) => Date.parse(e.at) < since)];
  const out: Insight[] = [];
  const latest = (xs: UsageEvent[]): string => xs[xs.length - 1]!.at;
  const group = <K extends string>(xs: UsageEvent[], key: (e: UsageEvent) => K | undefined): Map<K, UsageEvent[]> => {
    const m = new Map<K, UsageEvent[]>();
    for (const e of xs) {
      const k = key(e);
      if (k === undefined) continue;
      const list = m.get(k);
      if (list) list.push(e);
      else m.set(k, [e]);
    }
    return m;
  };

  // A vault key in a tool call's arguments: always worth a look, even once.
  for (const [k, xs] of group(inWindow.filter((e) => e.blocked === 'secret'), (e) => `${e.client}\u0000${e.serverId}__${e.tool}`)) {
    const [client, full] = k.split('\u0000') as [string, string];
    out.push({
      id: `secret-blocked:${k}`,
      severity: 'high',
      rule: 'secret-blocked',
      title: `${client} tried to send a vault key to ${full}`,
      detail: `${xs.length} call${xs.length === 1 ? '' : 's'} refused: the arguments contained the value of a credential in your vault. Nothing reached the server. If you did not ask for this, the agent may be following instructions it read somewhere.`,
      client,
      serverId: xs[0]!.serverId,
      tool: xs[0]!.tool,
      at: latest(xs),
      count: xs.length,
    });
  }

  // Repeated policy refusals from one caller: probing for something it was not given.
  for (const [client, xs] of group(inWindow.filter((e) => e.blocked === 'policy'), (e) => e.client)) {
    if (xs.length < PROBE_THRESHOLD) continue;
    const tools = new Set(xs.map((e) => `${e.serverId}__${e.tool}`));
    out.push({
      id: `policy-probing:${client}`,
      severity: 'high',
      rule: 'policy-probing',
      title: `${client} keeps calling tools it is not allowed`,
      detail: `${xs.length} refused calls across ${tools.size} tool${tools.size === 1 ? '' : 's'} (${[...tools].slice(0, 3).join(', ')}${tools.size > 3 ? ', ...' : ''}). Either it needs more access, or something is steering it toward what it was denied.`,
      client,
      at: latest(xs),
      count: xs.length,
    });
  }

  // The first time a caller used a tool that can change things. One insight per
  // caller, listing the tools, so a fresh install with ten unannotated tools
  // reads as one thing to check rather than ten.
  const seenDestructive = new Set(before.filter((e) => e.destructive && !e.blocked).map((e) => `${e.client}\u0000${e.serverId}__${e.tool}`));
  const firstWrites = inWindow.filter((e) => e.destructive && !e.blocked && !seenDestructive.has(`${e.client}\u0000${e.serverId}__${e.tool}`));
  for (const [client, xs] of group(firstWrites, (e) => e.client)) {
    const tools = [...new Set(xs.map((e) => `${e.serverId}__${e.tool}`))];
    const one = tools.length === 1;
    out.push({
      id: `first-destructive:${client}`,
      severity: 'medium',
      rule: 'first-destructive',
      title: one ? `${client} used ${tools[0]} for the first time` : `${client} used ${tools.length} tools that can change things for the first time`,
      detail: `${one ? 'This tool is' : `${tools.slice(0, 4).join(', ')}${tools.length > 4 ? ', ...' : ''} are`} not declared read-only by ${one ? 'its server' : 'their servers'}, so ${one ? 'it' : 'they'} may change or delete things. ${xs.length} call${xs.length === 1 ? '' : 's'} in the window.`,
      client,
      ...(one ? { serverId: xs[0]!.serverId, tool: xs[0]!.tool } : {}),
      at: latest(xs),
      count: xs.length,
    });
  }

  // Bursts: many calls from one caller inside a minute (sliding window).
  for (const [client, xs] of group(inWindow, (e) => e.client)) {
    let best = 0;
    let bestAt = '';
    let i = 0;
    for (let j = 0; j < xs.length; j++) {
      while (Date.parse(xs[j]!.at) - Date.parse(xs[i]!.at) > BURST_WINDOW_MS) i++;
      if (j - i + 1 > best) {
        best = j - i + 1;
        bestAt = xs[j]!.at;
      }
    }
    if (best >= BURST_CALLS) {
      out.push({
        id: `burst:${client}`,
        severity: 'medium',
        rule: 'burst',
        title: `${client} made ${best} calls in one minute`,
        detail: 'A loop, a runaway task, or a bulk job. Worth checking it is the one you started.',
        client,
        at: bestAt,
        count: best,
      });
    }

    // Error spikes: a caller whose calls mostly fail.
    const ran = xs.filter((e) => !e.blocked);
    const errors = ran.filter((e) => !e.ok).length;
    if (ran.length >= ERROR_SPIKE_MIN_CALLS && errors / ran.length >= ERROR_SPIKE_RATIO) {
      out.push({
        id: `error-spike:${client}`,
        severity: 'medium',
        rule: 'error-spike',
        title: `${Math.round((errors / ran.length) * 100)}% of ${client}'s calls failed`,
        detail: `${errors} of ${ran.length} calls returned an error. A server may be misconfigured, or the agent is guessing at arguments.`,
        client,
        at: latest(xs),
        count: errors,
      });
    }
  }

  // A caller not seen before the window.
  const knownClients = new Set(before.map((e) => e.client));
  for (const [client, xs] of group(inWindow, (e) => e.client)) {
    if (knownClients.has(client)) continue;
    out.push({
      id: `new-caller:${client}`,
      severity: 'low',
      rule: 'new-caller',
      title: `New caller: ${client}`,
      detail: `Not seen before this window. ${xs.length} call${xs.length === 1 ? '' : 's'} so far. If you do not recognise it, check which token it is using.`,
      client,
      at: latest(xs),
      count: xs.length,
    });
  }

  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || Date.parse(b.at) - Date.parse(a.at));
};
