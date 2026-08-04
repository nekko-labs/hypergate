import type {
  ServerStatus,
  RegistryEntry,
  GatewayInfo,
  ManagedServerConfig,
  AnalyticsSummary,
  AgentClientInfo,
  CreateAgentRequest,
  SettingsInfo,
  UpdateSettingsRequest,
  PopularityMap,
  CliStatus,
  CliCheckResult,
  ConnectTargetsInfo,
  AgentConnectInfo,
  ConnectResult,
  ShutdownResponse,
  UpdateInfo,
  UpdateProgress,
  UpdateResult,
  ApplyUpdateResponse,
} from '@hypergate/shared';

// Dev proxies /api → daemon; in a packaged build set VITE_DAEMON_URL.
const BASE = (import.meta.env.VITE_DAEMON_URL ?? '').replace(/\/$/, '');
const j = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
};

export const api = {
  health: () => j<{ ok: boolean; version: string; servers: number }>('/health'),
  servers: () => j<ServerStatus[]>('/api/servers'),
  registry: () => j<RegistryEntry[]>('/api/registry'),
  gateway: () => j<GatewayInfo>('/api/gateway'),
  analytics: () => j<AnalyticsSummary>('/api/analytics'),
  logs: (id: string) => j<{ logs: string[] }>(`/api/servers/${id}/logs`),
  add: (cfg: Partial<ManagedServerConfig> & { token?: string }) =>
    j<ServerStatus & { authUrl?: string }>('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }),
  action: (id: string, action: 'start' | 'stop' | 'restart') => j<ServerStatus>(`/api/servers/${id}/${action}`, { method: 'POST' }),
  // Remote OAuth: (re)start the browser login. Returns { authUrl } to open.
  authorize: (id: string) => j<ServerStatus>(`/api/servers/${id}/authorize`, { method: 'POST' }),
  // Remote bearer auth: the token is sent only in this request body and is never
  // returned by the daemon or included in ManagedServerConfig.
  setToken: (id: string, token: string) =>
    j<ServerStatus>(`/api/servers/${id}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  // Remove is the whole eraser: the server, its OAuth grant, and its place in
  // every agent's allow-list. There is no separate sign-out.
  remove: (id: string) => j<{ ok: boolean }>(`/api/servers/${id}`, { method: 'DELETE' }),
  searchRegistry: (q: string) => j<RegistryEntry[]>(`/api/registry/search?q=${encodeURIComponent(q)}`),
  // Popularity scores for catalog ordering — fetched lazily when the catalog opens.
  popularity: () => j<PopularityMap>('/api/registry/popularity'),
  // CLIs section: detect installed command-line tools + ad-hoc availability check.
  clis: () => j<CliStatus[]>('/api/clis'),
  checkCli: (name: string) => j<CliCheckResult>(`/api/clis/check?name=${encodeURIComponent(name)}`),
  clients: () => j<AgentClientInfo[]>('/api/clients'),
  // `target` marks the agent as a known harness from the catalog: the daemon
  // takes its name from there and then refuses to rename it.
  addClient: (req: CreateAgentRequest) =>
    j<AgentClientInfo>('/api/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }),
  updateClient: (id: string, patch: { name?: string; servers?: '*' | string[] }) =>
    j<AgentClientInfo>(`/api/clients/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  removeClient: (id: string) => j<{ ok: boolean }>(`/api/clients/${id}`, { method: 'DELETE' }),
  // Flip one server on/off for one agent. The daemon owns the arithmetic: it
  // knows every configured server, so it can expand an "all servers" agent into
  // the explicit list it implies before removing one.
  setAgentServer: (agentId: string, serverId: string, allowed: boolean) =>
    j<AgentClientInfo>(`/api/clients/${agentId}/servers/${encodeURIComponent(serverId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed }),
    }),
  // Connecting an agent to a harness: which clients this machine has, the
  // commands/snippets for one agent, and the one-click install itself.
  connectTargets: () => j<ConnectTargetsInfo>('/api/connect/targets'),
  connectInfo: (id: string) => j<AgentConnectInfo>(`/api/clients/${id}/connect`),
  connect: (id: string, target: string) =>
    j<ConnectResult>(`/api/clients/${id}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) }),
  settings: () => j<SettingsInfo>('/api/settings'),
  updateSettings: (patch: UpdateSettingsRequest) =>
    j<SettingsInfo>('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  // Stop the daemon. Needs the master gateway token (an agent's scoped token
  // may call tools, not take the runtime down); the daemon answers first and
  // exits after the response is flushed, so a 200 here means it's going down.
  shutdown: (token: string) =>
    j<ShutdownResponse>('/api/shutdown', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
  // Updates. `update()` is the cached answer and never touches the network;
  // `checkUpdate()` asks the daemon to look (it caches for a day, so calling it
  // when the manager opens costs nothing), and `force` skips that cache.
  update: () => j<UpdateInfo>('/api/update'),
  checkUpdate: (force = false) => j<UpdateInfo>(`/api/update/check${force ? '?force=1' : ''}`, { method: 'POST' }),
  // Download without installing: the daemon fetches the packages and stays up,
  // which is what makes "download only" a real choice. Both this and
  // `applyUpdate` answer immediately; `updateProgress()` is where the story is.
  downloadUpdate: (token: string) =>
    j<{ ok: boolean; version?: string; total?: number }>('/api/update/download', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  applyUpdate: (token: string) =>
    j<ApplyUpdateResponse>('/api/update/apply', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
  updateProgress: () => j<UpdateProgress>('/api/update/progress'),
  // Read once: the daemon clears it, so the version that just came up reports
  // the update that produced it exactly one time.
  updateResult: () => j<UpdateResult>('/api/update/result'),
};
