// Version 1 is a closed wire format: never reuse a local config or accept free-form strings.
export const catalogIds = ["nekko-agent","context7","supabase","linear","figma","vercel","github","playwright","cloudflare","cloudflare-docs","atlassian","azure","aws","gcp-toolbox","higgsfield","meta-ads","figma-devmode","filesystem","fetch","postgres","fly","nekko-vault"] as const;
const catalog = new Set<string>(catalogIds);
export interface PortableSetup {
  version: 1; startMinimized: boolean; closeAction: 'ask' | 'tray' | 'quit';
  servers: { catalogId: string; enabled: boolean }[];
}
export function fields(x: unknown, keys: string[]): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
}
export function isSetup(x: unknown): x is PortableSetup {
  if (!fields(x,['version','startMinimized','closeAction','servers']) || x.version !== 1 || typeof x.startMinimized !== 'boolean' ||
    !['ask','tray','quit'].some(k => k === x.closeAction) || !Array.isArray(x.servers) || x.servers.length > catalog.size) return false;
  const seen = new Set<string>();
  return x.servers.every(s => {
    if (!fields(s,['catalogId','enabled']) || typeof s.catalogId !== 'string' || !catalog.has(s.catalogId) || seen.has(s.catalogId) || typeof s.enabled !== 'boolean') return false;
    seen.add(s.catalogId); return true;
  });
}
