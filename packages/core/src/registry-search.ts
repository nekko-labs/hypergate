import type { RegistryEntry, RemoteTransport } from '@hypergate/shared';
import { bestRow, resolveServerName, selectPackage, type ResolvablePackage } from './resolve.js';
import { compareVersions } from './update.js';

/**
 * Search the official, open-source MCP Registry (registry.modelcontextprotocol.io,
 * repo modelcontextprotocol/registry) — the canonical community catalog — and
 * map each hit into our RegistryEntry so the existing Add flow can consume it
 * unchanged.
 *
 * This is the one deliberate outbound call Hypergate makes: it fires only when a
 * user searches, never on boot. `fetchImpl` is injectable so the mapper is
 * unit-tested against canned JSON with no network.
 */

const DEFAULT_BASE = 'https://registry.modelcontextprotocol.io';

/** Shape of a registry `/v0/servers` response (only the fields we read). */
interface RegistryArg {
  type?: string; // 'positional' | 'named'
  name?: string;
  value?: string;
  default?: string;
  isRequired?: boolean;
}
interface RegistryPackage extends ResolvablePackage {
  registryType?: string; // npm | pypi | oci | nuget | mcpb
  registry_type?: string; // tolerate snake_case variants
  identifier?: string;
  name?: string;
  version?: string;
  transport?: { type?: string };
  environmentVariables?: { name: string; isRequired?: boolean }[];
  runtimeArguments?: RegistryArg[];
  packageArguments?: RegistryArg[];
  /** Integrity hash on a platform-specific `mcpb` binary bundle. */
  fileSha256?: string;
}
interface RegistryServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  packages?: RegistryPackage[];
  remotes?: { type?: string; url?: string }[];
  repository?: { url?: string };
  websiteUrl?: string;
}
interface RegistryResponse {
  servers?: { server?: RegistryServer }[];
  metadata?: { nextCursor?: string; count?: number };
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'server';

/** Last human-friendly segment of a reverse-DNS-ish registry name. */
const shortName = (name: string): string => {
  const seg = name.split('/').pop() ?? name;
  return seg.split('.').pop() ?? seg;
};

/** Concrete arg tokens we can safely pre-fill (those with a value/default). */
const argTokens = (args: RegistryArg[] | undefined): string[] => {
  const out: string[] = [];
  for (const a of args ?? []) {
    const v = a.value ?? a.default;
    if (a.type === 'named' && a.name) {
      out.push(a.name);
      if (v) out.push(v);
    } else if (v) {
      out.push(v);
    }
  }
  return out;
};

const pkgType = (p: RegistryPackage): string => (p.registryType ?? p.registry_type ?? '').toLowerCase();

/**
 * Trust signal from the registry's reverse-DNS namespace (the part before `/`).
 * Domain namespaces (`com.linear`, `app.linear`) require DNS/HTTP domain
 * verification to publish ⇒ first-party. `io.github.*` only proves control of a
 * GitHub account, and the anonymous namespace proves nothing ⇒ community.
 * Returns `undefined` when there's no namespace to judge.
 */
export function officialFromNamespace(namespace: string): boolean | undefined {
  const ns = namespace.trim();
  if (!ns) return undefined;
  if (ns.startsWith('io.github.') || ns === 'io.modelcontextprotocol.anonymous') return false;
  return ns.includes('.'); // a real reverse-DNS (domain-verified) namespace
}

/** The registry spells streamable HTTP `streamable-http`; we call it `http`. */
const remoteTransport = (type?: string): RemoteTransport => (String(type).toLowerCase() === 'sse' ? 'sse' : 'http');

/** Map one registry server to a RegistryEntry (or a non-runnable, noted entry). */
export function mapRegistryServer(srv: RegistryServer): RegistryEntry {
  const rawName = srv.name ?? 'unknown';
  const namespace = rawName.includes('/') ? rawName.split('/')[0] : '';
  const base: RegistryEntry = {
    id: slug(rawName),
    name: srv.title || shortName(rawName),
    description: srv.description ?? '',
    runtime: 'process',
    command: '',
    homepage: srv.repository?.url ?? srv.websiteUrl,
    source: 'registry',
    runnable: false,
    publisher: namespace || undefined,
    official: officialFromNamespace(namespace),
  };

  // Prefer a stdio package we know how to launch, best channel first. An `mcpb`
  // bundle only counts when one of its per-OS builds matches this machine.
  const packages = srv.packages ?? [];
  const chosen = selectPackage(packages);

  if (chosen && chosen.type !== 'mcpb') {
    const { identifier: id, version = '' } = chosen;
    const pkg = chosen.pkg as RegistryPackage;
    const requires = (pkg.environmentVariables ?? []).map((e) => e.name);
    const extraArgs = [...argTokens(pkg.runtimeArguments), ...argTokens(pkg.packageArguments)];

    if (chosen.type === 'npm') {
      return { ...base, runtime: 'process', command: 'npx', args: ['-y', version ? `${id}@${version}` : id, ...extraArgs], requires, runnable: true };
    }
    if (chosen.type === 'pypi') {
      return { ...base, runtime: 'process', command: 'uvx', args: [id, ...extraArgs], requires, runnable: true, note: version ? `pin ${id}==${version} if needed` : undefined };
    }
    // oci / docker
    const image = version && !id.includes(':') ? `${id}:${version}` : id;
    return { ...base, runtime: 'docker', command: '', image, args: extraArgs, requires, runnable: true, note: 'Docker runtime — needs Docker installed.' };
  }

  // A remote endpoint is a perfectly good way to reach a server, and it is what
  // three quarters of the registry publishes. Auth is unknown at this point:
  // `oauth` is both the common case and the daemon's own default, and
  // `probeRemoteAuth` refines it when the caller can afford a round trip.
  const remote = (srv.remotes ?? []).find((r) => r.url);
  if (remote?.url) {
    return {
      ...base,
      runtime: 'remote',
      command: '',
      url: remote.url,
      transport: remoteTransport(remote.type),
      auth: 'oauth',
      runnable: true,
    };
  }

  if (chosen?.type === 'mcpb') {
    return { ...base, note: 'Ships as an `mcpb` binary bundle — Hypergate cannot install those yet.' };
  }
  const unknownPkg = packages.find((p) => pkgType(p));
  if (unknownPkg) return { ...base, note: `Package type "${pkgType(unknownPkg)}" not launchable by Hypergate yet.` };
  if ((srv.remotes ?? []).length > 0) return { ...base, note: 'Remote server listed with no endpoint URL.' };
  return { ...base, note: 'No installable package listed.' };
}

/** Search the registry and return mapped catalog entries. */
export async function searchRegistry(
  query: string,
  opts: { limit?: number; base?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RegistryEntry[]> {
  const { limit = 20, base = DEFAULT_BASE, fetchImpl = fetch, signal } = opts;
  const url = new URL('/v0/servers', base);
  if (query.trim()) url.searchParams.set('search', query.trim());
  url.searchParams.set('limit', String(limit));

  const res = await fetchImpl(url.toString(), { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const data = (await res.json()) as RegistryResponse;
  // The registry returns one row per *version*, so a server that has shipped
  // five releases appears five times under the same name. Collapse to one row
  // each, keeping the newest stable release — NOT the first row returned. The
  // rows arrive oldest-first and lexically sorted (`0.2.0, 0.2.11, 0.2.2`), so
  // "keep the first" pinned every multi-version server to a stale version, and
  // sorting the strings would rank `0.2.2` above `0.2.14`. See `resolve.ts`.
  const byName = new Map<string, RegistryServer[]>();
  for (const row of data.servers ?? []) {
    const srv = row.server ?? {};
    const key = srv.name ?? '';
    const group = byName.get(key);
    if (group) group.push(srv);
    else byName.set(key, [srv]);
  }
  return [...byName.values()].map((group) => mapRegistryServer(bestRow(group) ?? group[0]));
}

/** What `resolveServer` needs beyond the query. */
export interface ResolveServerOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Take the newest version even when it is a prerelease. Off by default. */
  allowPrerelease?: boolean;
  /** How many rows to scan when looking the name up. */
  limit?: number;
}

/** A name resolved to one pinned, ready-to-add server. */
export interface ResolvedServer {
  ok: true;
  /** The canonical registry name (`com.microsoft/azure`). */
  name: string;
  /** The version selected, when the registry states one. */
  version?: string;
  /** Every version seen, newest-first — what the choice was made from. */
  versions: string[];
  /** Ready for the existing Add flow. */
  entry: RegistryEntry;
}

/** Why a name could not be turned into one server. */
export interface UnresolvedServer {
  ok: false;
  reason: 'not_found' | 'ambiguous';
  /** The names that matched, so the caller can ask rather than guess. */
  candidates: string[];
}

export type ResolveResult = ResolvedServer | UnresolvedServer;

/**
 * Turn a name a person typed into one pinned server, ready to add.
 *
 * Two round trips, and both are load-bearing. The search finds the canonical
 * name — `?name=` does not reliably filter, so the exact match is made here
 * against what came back. Then the per-server versions endpoint supplies the
 * *complete* release history, because a plain search is capped by `limit` and
 * truncates it: `com.microsoft/azure` has 34 published versions, so a 20-row
 * search never sees the newest stable one at all.
 */
export async function resolveServer(query: string, opts: ResolveServerOptions = {}): Promise<ResolveResult> {
  const { base = DEFAULT_BASE, fetchImpl = fetch, signal, allowPrerelease, limit = 50 } = opts;
  const getJson = async (path: string): Promise<RegistryResponse | undefined> => {
    const res = await fetchImpl(new URL(path, base).toString(), { signal, headers: { accept: 'application/json' } });
    return res.ok ? ((await res.json()) as RegistryResponse) : undefined;
  };
  const versionsOf = (name: string): Promise<RegistryResponse | undefined> =>
    getJson(`/v0/servers/${encodeURIComponent(name)}/versions`).catch(() => undefined);

  const pick = (name: string, pool: RegistryServer[], fallback?: RegistryServer): ResolvedServer => {
    const chosen = bestRow(pool, { allowPrerelease }) ?? fallback ?? pool[0] ?? {};
    return {
      ok: true,
      name,
      version: chosen.version,
      versions: pool
        .map((r) => r.version ?? '')
        .filter(Boolean)
        .sort((a, b) => compareVersions(b, a)),
      entry: mapRegistryServer(chosen),
    };
  };

  // A fully-qualified name can go straight to that server's version history,
  // skipping the search entirely. Worth doing: the versions endpoint answers in
  // well under a second, while `?search=` is measured anywhere from 0.9s to 24s
  // for the same query, and the search adds nothing when the name is already exact.
  const trimmed = query.trim();
  if (trimmed.includes('/')) {
    const direct = await versionsOf(trimmed);
    const rows = (direct?.servers ?? []).map((s) => s.server ?? {});
    if (rows.length) return pick(rows[0].name ?? trimmed, rows);
    // A 404 here just means the name is not exact; fall through and search.
  }

  const found = await getJson(`/v0/servers?search=${encodeURIComponent(trimmed)}&limit=${limit}`);
  const rows = (found?.servers ?? []).map((s) => s.server ?? {});
  // One entry per distinct name: the search returns a row per version, and the
  // ambiguity check is about servers, not releases.
  const distinct: RegistryServer[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name ?? '';
    if (name && !seen.has(name)) {
      seen.add(name);
      distinct.push(row);
    }
  }

  const resolution = resolveServerName(query, distinct);
  if (!resolution.match) {
    return { ok: false, reason: resolution.ambiguous ? 'ambiguous' : 'not_found', candidates: resolution.candidates.map((c) => c.name ?? '') };
  }

  const name = resolution.match.name ?? '';
  // The full history. A search is capped at 50 rows and returns one per version,
  // so it truncates the history of anything long-lived: `com.microsoft/azure`
  // has 34 releases. If this endpoint is unavailable the search rows are still
  // a usable answer, just a narrower one.
  const history = await versionsOf(name);
  const historyRows = (history?.servers ?? []).map((s) => s.server ?? {});
  const pool = historyRows.length ? historyRows : rows.filter((r) => r.name === name);
  return pick(name, pool, resolution.match);
}
