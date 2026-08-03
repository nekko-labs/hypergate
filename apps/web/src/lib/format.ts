import type { RegistryEntry, PopularityMap } from '@hypergate/shared';

export const fmtNum = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);

export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const fmtRel = (iso?: string): string => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export const fmtClock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour12: false });

/** Open a provider's OAuth sign-in in a popup window (falls back to a new tab). */
export const openAuth = (authUrl?: string): void => {
  if (!authUrl) return;
  window.open(authUrl, 'hypergate-oauth', 'width=600,height=760,noopener');
};

export const RUNTIME_CHIP: Record<string, string> = { docker: '🐳 docker', remote: '🌐 remote', process: '⚡ process' };

export const STATE_PILL: Record<string, string> = {
  ready: 'pill-ready',
  starting: 'pill-starting',
  errored: 'pill-errored',
  stopped: 'pill-stopped',
  authorizing: 'pill-authorizing',
};

/**
 * Order the catalog like the daemon's sortRegistry, but client-side (we don't
 * bundle @hypergate/core into the browser): recommended entries first — keeping
 * the daemon's authored order (kotrain, context7, supabase, linear, figma) — then
 * the rest by popularity desc, with a stable fallback to the original order.
 */
export function sortCatalog(entries: RegistryEntry[], pop: PopularityMap): RegistryEntry[] {
  const score = (e: RegistryEntry): number => pop[e.id] ?? e.popularity ?? -1;
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ra = a.e.recommended ? 0 : 1;
      const rb = b.e.recommended ? 0 : 1;
      if (ra !== rb) return ra - rb;
      if (ra === 1) {
        const d = score(b.e) - score(a.e);
        if (d !== 0) return d;
      }
      return a.i - b.i;
    })
    .map((x) => x.e);
}
