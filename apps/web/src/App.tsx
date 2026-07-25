import { useEffect, useState, useCallback } from 'react';
import type {
  ServerStatus,
  RegistryEntry,
  GatewayInfo,
  AnalyticsSummary,
  AgentClientInfo,
} from '@hypergate/shared';
import { api } from './api';
import type { View } from './types';
import { fmtNum } from './lib/format';
import { ToastProvider } from './toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeSwitch } from './components/ThemeSwitch';
import { ServersView } from './views/ServersView';
import { AnalyticsView } from './views/AnalyticsView';
import { SettingsView } from './views/SettingsView';

export function App() {
  const [view, setView] = useState<View>('servers');
  const [servers, setServers] = useState<ServerStatus[] | null>(null);
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [stats, setStats] = useState<AnalyticsSummary | null>(null);
  const [agents, setAgents] = useState<AgentClientInfo[]>([]);
  const [offline, setOffline] = useState(false);

  const refreshAgents = useCallback(() => {
    void api.clients().then(setAgents).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, a, c] = await Promise.all([api.servers(), api.analytics().catch(() => null), api.clients().catch(() => null)]);
      setServers(s);
      if (a) setStats(a);
      if (c) setAgents(c);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api.registry().then(setRegistry).catch(() => {});
    void api.gateway().then(setGateway).catch(() => {});
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <ToastProvider>
      <header className="topbar">
        <div className="topbar-in">
          <div className="logo-tile"><img src="/favicon.svg" alt="" width="22" height="22" /></div>
          <span className="wordmark">Hypergate</span>
          <span className="chip">v0.7</span>
          <nav className="nav">
            <button className={view === 'servers' ? 'active' : ''} onClick={() => setView('servers')}>Servers</button>
            <button className={view === 'analytics' ? 'active' : ''} onClick={() => setView('analytics')}>
              Analytics{stats && stats.totalCalls > 0 && <span className="n-badge">{fmtNum(stats.totalCalls)}</span>}
            </button>
            <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>Settings</button>
          </nav>
          <div className="spacer" />
          <ThemeSwitch />
          <span className={`pill ${offline ? 'pill-errored' : 'pill-ready'}`}>
            <span className="dot" />
            {offline ? 'daemon offline' : 'daemon up'}
          </span>
          <a className="small muted" href="https://github.com/nekko-labs/hypergate" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </header>

      <div className="wrap">
        {offline && (
          <div className="banner">
            <b>Can't reach the daemon.</b>{' '}
            <span className="muted">Start it with <code>npm run daemon</code> (or <code>npm run dev</code>) — this page reconnects automatically.</span>
          </div>
        )}

        <ErrorBoundary surface={view}>
          {view === 'servers' ? (
            <ServersView
              servers={servers}
              registry={registry}
              gateway={gateway}
              agents={agents}
              refresh={() => void refresh()}
              refreshAgents={refreshAgents}
            />
          ) : view === 'analytics' ? (
            <AnalyticsView stats={stats} />
          ) : (
            <SettingsView />
          )}
        </ErrorBoundary>

        <div className="footer">
          <span>Local-first · MIT · Nekko Labs</span>
          <div className="spacer" style={{ flex: 1 }} />
          <a href="https://github.com/nekko-labs/hypergate" target="_blank" rel="noreferrer">nekko-labs/hypergate</a>
        </div>
      </div>
    </ToastProvider>
  );
}
