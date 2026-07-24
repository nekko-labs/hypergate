import type {
  ServerStatus,
  RegistryEntry,
  GatewayInfo,
  ManagedServerConfig,
  AnalyticsSummary,
  AgentClientInfo,
  SettingsInfo,
  UpdateSettingsRequest,
  PopularityMap,
  CliStatus,
  CliCheckResult,
} from '@hypergate/shared';

// Dev proxies /api → daemon; in a packaged build set VITE_DAEMON_URL.
const BASE = (import.meta.env.VITE_DAEMON_URL ?? '').replace(/\/$/, '');
const j = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
};

export const api = {
  servers: () => j<ServerStatus[]>('/api/servers'),
  registry: () => j<RegistryEntry[]>('/api/registry'),
  gateway: () => j<GatewayInfo>('/api/gateway'),
  analytics: () => j<AnalyticsSummary>('/api/analytics'),
  logs: (id: string) => j<{ logs: string[] }>(`/api/servers/${id}/logs`),
  add: (cfg: Partial<ManagedServerConfig>) => j<ServerStatus>('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }),
  action: (id: string, action: 'start' | 'stop' | 'restart') => j<ServerStatus>(`/api/servers/${id}/${action}`, { method: 'POST' }),
  // Remote OAuth: (re)start the browser login (returns { authUrl } to open), or disconnect (sign out).
  authorize: (id: string) => j<ServerStatus>(`/api/servers/${id}/authorize`, { method: 'POST' }),
  disconnect: (id: string) => j<ServerStatus>(`/api/servers/${id}/disconnect`, { method: 'POST' }),
  remove: (id: string) => j<{ ok: boolean }>(`/api/servers/${id}`, { method: 'DELETE' }),
  searchRegistry: (q: string) => j<RegistryEntry[]>(`/api/registry/search?q=${encodeURIComponent(q)}`),
  // Popularity scores for catalog ordering — fetched lazily when the catalog opens.
  popularity: () => j<PopularityMap>('/api/registry/popularity'),
  // CLIs section: detect installed command-line tools + ad-hoc availability check.
  clis: () => j<CliStatus[]>('/api/clis'),
  checkCli: (name: string) => j<CliCheckResult>(`/api/clis/check?name=${encodeURIComponent(name)}`),
  clients: () => j<AgentClientInfo[]>('/api/clients'),
  addClient: (name: string, servers: '*' | string[]) =>
    j<AgentClientInfo>('/api/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, servers }) }),
  updateClient: (id: string, patch: { name?: string; servers?: '*' | string[] }) =>
    j<AgentClientInfo>(`/api/clients/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  removeClient: (id: string) => j<{ ok: boolean }>(`/api/clients/${id}`, { method: 'DELETE' }),
  settings: () => j<SettingsInfo>('/api/settings'),
  updateSettings: (patch: UpdateSettingsRequest) =>
    j<SettingsInfo>('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
};
