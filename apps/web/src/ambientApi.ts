import type {
  AmbientImportResult,
  AmbientScanResponse,
  SettingsInfo,
  TestAlertResponse,
  UpdateSettingsRequest,
  WatchEventsResponse,
} from '@hypergate/shared';

// The ambient sweep, watcher events and alert settings. Kept beside api.ts
// rather than in it so the vault-lockdown work can grow that file freely.
const BASE = (import.meta.env.VITE_DAEMON_URL ?? '').replace(/\/$/, '');

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${BASE}${path}`, init);
  // The import and settings routes answer errors with a JSON body that says
  // why; surface that instead of a bare status code.
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
};

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

export const ambientApi = {
  scan: () => call<AmbientScanResponse>('/api/ambient'),
  importFinding: (id: string, token: string) =>
    call<AmbientImportResult>(`/api/ambient/${encodeURIComponent(id)}/import`, { method: 'POST', headers: bearer(token) }),
  events: () => call<WatchEventsResponse>('/api/watch/events'),
  testAlert: (token: string) => call<TestAlertResponse>('/api/alerts/test', { method: 'POST', headers: bearer(token) }),
  /** A settings PATCH carrying the master token, which every alert field needs. */
  updateAlertSettings: (patch: UpdateSettingsRequest, token: string) =>
    call<SettingsInfo>('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify(patch),
    }),
};
