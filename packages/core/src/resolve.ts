/**
 * Resolving a registry name to something Hypergate can actually run.
 *
 * The live MCP Registry (registry.modelcontextprotocol.io) is looser than its
 * schema suggests, and three of its habits will silently install the wrong
 * thing if you take the response at face value:
 *
 *  1. **It returns one row per published version, ascending.** `registry-search`
 *     used to keep the first row of each name on the belief that the registry
 *     ordered newest-first. It does not, and the sort is lexical on top of that
 *     (`0.2.0, 0.2.11, 0.2.2, 0.2.14`), so "first" meant *oldest*. Measured
 *     against the live registry, every multi-version server resolved to a stale
 *     release. `bestRow` picks by semver precedence instead.
 *
 *  2. **`?name=` does not reliably filter.** Asking for `com.microsoft/azure`
 *     comes back with the unfiltered list (71 unrelated names in one page), and
 *     `?search=` is fuzzy enough that `azure` matches `com.azurecarbon/kodiak`.
 *     Exact matching therefore happens here, on names we have in hand, with an
 *     ambiguity guard rather than a guess.
 *
 *  3. **`?version=latest` can be a prerelease.** For `com.microsoft/azure` it is
 *     `3.0.0-beta.37` while the newest stable is `2.0.2`. Preferring stable is
 *     the default; `allowPrerelease` opts back in deliberately.
 *
 * Everything here is pure and unit-tested — no network, no filesystem.
 */

import type { ManagedServerConfig, RegistryEntry } from '@hypergate/shared';
import { compareVersions } from './update.js';

/** A registry package, in the shape the registry actually serves it. */
export interface ResolvablePackage {
  registryType?: string;
  registry_type?: string;
  identifier?: string;
  name?: string;
  version?: string;
  /** Integrity hash, present on `mcpb` binary bundles. */
  fileSha256?: string;
  [key: string]: unknown;
}

/** Package channels we know how to launch, best first. */
export const PACKAGE_PREFERENCE = ['npm', 'pypi', 'oci', 'docker', 'mcpb'] as const;
export type PackageType = (typeof PACKAGE_PREFERENCE)[number];

/** A chosen package, normalised. */
export interface SelectedPackage {
  type: PackageType;
  identifier: string;
  version?: string;
  /** Integrity hash for a binary bundle, when the registry states one. */
  sha256?: string;
  pkg: ResolvablePackage;
}

const packageType = (p: ResolvablePackage): string => (p.registryType ?? p.registry_type ?? '').toLowerCase();
const packageId = (p: ResolvablePackage): string => p.identifier ?? p.name ?? '';

/**
 * True when a version carries a semver prerelease suffix (`-beta.37`). Build
 * metadata (`+build.5`) is not a prerelease and must not be read as one.
 */
export function isPrerelease(version: string): boolean {
  const core = (version ?? '').trim().split('+')[0];
  return /^v?\d+(?:\.\d+){0,2}-[0-9A-Za-z.-]+/.test(core);
}

/**
 * The version a user should get: newest stable, or newest overall when the
 * project has only ever shipped prereleases (or the caller opts in).
 */
export function bestVersion(versions: string[], opts: { allowPrerelease?: boolean } = {}): string | undefined {
  if (!versions.length) return undefined;
  const newest = (list: string[]): string | undefined =>
    list.length ? list.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best)) : undefined;
  if (opts.allowPrerelease) return newest(versions);
  return newest(versions.filter((v) => !isPrerelease(v))) ?? newest(versions);
}

/**
 * The row to keep out of several versions of the same server. This is the fix
 * for the stale-pin bug: pick by precedence, never by arrival order.
 */
export function bestRow<T extends { version?: string }>(rows: T[], opts: { allowPrerelease?: boolean } = {}): T | undefined {
  if (!rows.length) return undefined;
  const best = bestVersion(rows.map((r) => r.version ?? ''), opts);
  return rows.find((r) => (r.version ?? '') === best) ?? rows[0];
}

/** Outcome of resolving a user-typed name against a set of registry servers. */
export interface NameResolution<T> {
  /** The one server this name means, when that is unambiguous. */
  match?: T;
  /** True when several servers matched and picking one would be a guess. */
  ambiguous: boolean;
  /** Everything that matched, in registry order — what to show the user. */
  candidates: T[];
}

/**
 * Resolve a typed name to a single server. An exact name always wins outright
 * (so `com.microsoft/azure` can never resolve to `com.microsoft/azure-devops`);
 * a partial match resolves only when it is the only one.
 */
export function resolveServerName<T extends { name?: string }>(query: string, servers: T[]): NameResolution<T> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { ambiguous: false, candidates: [] };

  const exact = servers.filter((s) => (s.name ?? '').toLowerCase() === needle);
  if (exact.length) return { match: exact[0], ambiguous: false, candidates: exact };

  const partial = servers.filter((s) => (s.name ?? '').toLowerCase().includes(needle));
  if (partial.length === 1) return { match: partial[0], ambiguous: false, candidates: partial };
  return { ambiguous: partial.length > 1, candidates: partial };
}

/**
 * Tokens a platform-specific release asset might name this machine with.
 * `mcpb` bundles ship one file per OS/arch and there is no field saying which
 * is which — the platform lives in the filename, spelled the way whoever cut
 * the release spells it (`osx-arm64`, `darwin-arm64`, `macos-aarch64`).
 */
export function platformTargets(platform: string = process.platform, arch: string = process.arch): string[] {
  const os: Record<string, string[]> = {
    darwin: ['osx', 'darwin', 'macos'],
    win32: ['win', 'windows', 'win32'],
    linux: ['linux'],
  };
  const cpu: Record<string, string[]> = {
    arm64: ['arm64', 'aarch64'],
    x64: ['x64', 'amd64', 'x86_64'],
    ia32: ['x86', 'i386'],
  };
  const oses = os[platform] ?? [platform];
  const cpus = cpu[arch] ?? [arch];
  return oses.flatMap((o) => cpus.map((c) => `${o}-${c}`));
}

/** Context for choosing between a server's packages. */
export interface SelectContext {
  platform?: string;
  arch?: string;
  /** Force a channel (`npm`, `oci`…) instead of taking the preferred one. */
  prefer?: PackageType;
}

/**
 * Choose the package to install, best channel first. `mcpb` is only ever
 * selected when one of its bundles is built for this machine — an unmatched
 * binary is not a fallback, it is a download that cannot run.
 */
export function selectPackage(packages: ResolvablePackage[], ctx: SelectContext = {}): SelectedPackage | undefined {
  const order = ctx.prefer ? [ctx.prefer, ...PACKAGE_PREFERENCE.filter((t) => t !== ctx.prefer)] : [...PACKAGE_PREFERENCE];
  const targets = platformTargets(ctx.platform, ctx.arch);

  for (const type of order) {
    for (const pkg of packages) {
      if (packageType(pkg) !== type) continue;
      const identifier = packageId(pkg);
      if (!identifier) continue;
      if (type === 'mcpb') {
        const file = identifier.toLowerCase();
        if (!targets.some((t) => file.includes(t))) continue; // not built for this machine
      }
      return {
        type: type as PackageType,
        identifier,
        version: pkg.version && pkg.version !== 'latest' ? pkg.version : undefined,
        sha256: typeof pkg.fileSha256 === 'string' ? pkg.fileSha256 : undefined,
        pkg,
      };
    }
  }
  return undefined;
}

/**
 * Turn a resolved catalog entry into a server the supervisor can manage.
 *
 * Keys the entry does not set are left out entirely rather than written as
 * `undefined`: this config is persisted to `servers.json`, and a file full of
 * explicit nulls is both noisier to read and harder to diff than one that only
 * states what applies.
 */
export function serverConfigFromEntry(
  entry: RegistryEntry,
  opts: { credentialRefs?: Record<string, string>; enabled?: boolean } = {},
): ManagedServerConfig {
  const cfg: ManagedServerConfig = {
    id: entry.id,
    name: entry.name,
    runtime: entry.runtime,
    command: entry.command ?? '',
    enabled: opts.enabled ?? true,
  };
  if (entry.args?.length) cfg.args = [...entry.args];
  if (entry.image) cfg.image = entry.image;
  if (entry.url) cfg.url = entry.url;
  if (entry.transport) cfg.transport = entry.transport;
  if (entry.auth) cfg.auth = entry.auth;
  if (entry.clientId) cfg.clientId = entry.clientId;
  if (entry.scope) cfg.scope = entry.scope;
  if (opts.credentialRefs && Object.keys(opts.credentialRefs).length) cfg.credentialRefs = { ...opts.credentialRefs };
  return cfg;
}
