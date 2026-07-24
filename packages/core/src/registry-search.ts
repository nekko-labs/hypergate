import type { RegistryEntry } from '@nekko-mcp/shared';

/**
 * Search the official, open-source MCP Registry (registry.modelcontextprotocol.io,
 * repo modelcontextprotocol/registry) — the canonical community catalog — and
 * map each hit into our RegistryEntry so the existing Add flow can consume it
 * unchanged.
 *
 * This is the one deliberate outbound call NekkoMCP makes: it fires only when a
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
interface RegistryPackage {
  registryType?: string; // npm | pypi | oci | nuget | mcpb
  registry_type?: string; // tolerate snake_case variants
  identifier?: string;
  name?: string;
  version?: string;
  transport?: { type?: string };
  environmentVariables?: { name: string; isRequired?: boolean }[];
  runtimeArguments?: RegistryArg[];
  packageArguments?: RegistryArg[];
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
const pkgId = (p: RegistryPackage): string => p.identifier ?? p.name ?? '';

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

  // Prefer a stdio package we know how to launch (npm/pypi/oci).
  const packages = srv.packages ?? [];
  const runnablePkg = packages.find((p) => ['npm', 'pypi', 'oci', 'docker'].includes(pkgType(p)));

  if (runnablePkg) {
    const type = pkgType(runnablePkg);
    const id = pkgId(runnablePkg);
    const version = runnablePkg.version && runnablePkg.version !== 'latest' ? runnablePkg.version : '';
    const requires = (runnablePkg.environmentVariables ?? []).map((e) => e.name);
    const extraArgs = [...argTokens(runnablePkg.runtimeArguments), ...argTokens(runnablePkg.packageArguments)];

    if (type === 'npm') {
      return { ...base, runtime: 'process', command: 'npx', args: ['-y', version ? `${id}@${version}` : id, ...extraArgs], requires, runnable: true };
    }
    if (type === 'pypi') {
      return { ...base, runtime: 'process', command: 'uvx', args: [id, ...extraArgs], requires, runnable: true, note: version ? `pin ${id}==${version} if needed` : undefined };
    }
    // oci / docker
    const image = version && !id.includes(':') ? `${id}:${version}` : id;
    return { ...base, runtime: 'docker', command: '', image, args: extraArgs, requires, runnable: true, note: 'Docker runtime — needs Docker installed.' };
  }

  const unknownPkg = packages.find((p) => pkgType(p));
  if (unknownPkg) return { ...base, note: `Package type "${pkgType(unknownPkg)}" not launchable by NekkoMCP yet.` };

  if ((srv.remotes ?? []).length > 0) {
    return { ...base, note: 'Remote server (streamable-http) — not locally runnable yet.' };
  }
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
  return (data.servers ?? []).map((s) => mapRegistryServer(s.server ?? {}));
}
