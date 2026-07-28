import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import type {
  ServerStatus,
  RegistryEntry,
  GatewayInfo,
  ManagedServerConfig,
  RuntimeKind,
  AnalyticsSummary,
  ToolInfo,
  AgentClientInfo,
  SettingsInfo,
  UpdateSettingsRequest,
  PopularityMap,
  CliStatus,
  CliCheckResult,
  ConnectShell,
  ConnectTargetStatus,
  ConnectTargetsInfo,
  AgentConnectInfo,
  ConnectResult,
} from '@hypergate/shared';
import { api } from './api';

type View = 'servers' | 'analytics' | 'settings';
type Theme = 'light' | 'medium' | 'dark';

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  }, []);
  return [copied, copy];
}

const fmtNum = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const fmtRel = (iso?: string): string => {
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
const fmtClock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour12: false });

/** Open a provider's OAuth sign-in in a popup window (falls back to a new tab). */
const openAuth = (authUrl?: string): void => {
  if (!authUrl) return;
  window.open(authUrl, 'hypergate-oauth', 'width=600,height=760,noopener');
};

const RUNTIME_CHIP: Record<string, string> = { docker: '🐳 docker', remote: '🌐 remote', process: '⚡ process' };

/**
 * Order the catalog like the daemon's sortRegistry, but client-side (we don't
 * bundle @hypergate/core into the browser): recommended entries first — keeping
 * the daemon's authored order (kotrain, context7, supabase, linear, figma) — then
 * the rest by popularity desc, with a stable fallback to the original order.
 */
function sortCatalog(entries: RegistryEntry[], pop: PopularityMap): RegistryEntry[] {
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

export function App() {
  const [view, setView] = useState<View>('servers');
  const [servers, setServers] = useState<ServerStatus[] | null>(null);
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [stats, setStats] = useState<AnalyticsSummary | null>(null);
  const [agents, setAgents] = useState<AgentClientInfo[]>([]);
  const [offline, setOffline] = useState(false);
  const [adding, setAdding] = useState<RegistryEntry | 'custom' | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [version, setVersion] = useState('');

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
    // The daemon knows its version; a hardcoded chip goes stale every release.
    void api.health().then((h) => setVersion(h.version)).catch(() => {});
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const running = servers?.filter((s) => s.state === 'ready').length ?? 0;
  const tools = servers?.reduce((n, s) => n + s.tools.length, 0) ?? 0;

  // One-click OAuth: add the remote server and pop the provider's login. No form,
  // no token to paste — the whole point of the feature. Falls back to /authorize
  // if the server was already added (e.g. a half-finished earlier attempt).
  const quickAddOAuth = useCallback(async (e: RegistryEntry) => {
    setShowCatalog(false);
    setAdding(null);
    try {
      const status = await api.add({
        id: e.id, name: e.name, runtime: 'remote', command: '',
        url: e.url, transport: e.transport ?? 'http', auth: 'oauth', enabled: true,
      });
      openAuth(status.authUrl);
    } catch {
      // Already added (409) or a transient error — (re)start the login instead.
      const status = await api.authorize(e.id).catch(() => null);
      openAuth(status?.authUrl);
    }
    void refresh();
  }, [refresh]);

  const handlePick = useCallback((e: RegistryEntry | 'custom') => {
    if (e !== 'custom' && e.runtime === 'remote' && e.auth === 'oauth') { void quickAddOAuth(e); return; }
    setAdding(e);
  }, [quickAddOAuth]);

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <div className="logo-tile"><img src="/favicon.svg" alt="" width="22" height="22" /></div>
          <span className="wordmark">Hypergate</span>
          {version && <span className="chip">v{version}</span>}
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
            <span className="muted">
              Start it from the tray menu (<b>Restart daemon</b>) or with <code>hypergate start</code>. In the repo,{' '}
              <code>npm run daemon</code>. This page reconnects automatically.
            </span>
          </div>
        )}

        {view === 'servers' ? (
          <>
            <div className="pagehead">
              <div>
                <h1>Every MCP server. <span className="grad-text">One endpoint.</span></h1>
                <p>Run servers in sandboxed processes or Docker, supervise them, and connect any agent through a single gateway URL — with full local visibility into every call.</p>
              </div>
              <div className="summary">
                <b>{servers?.length ?? '–'}</b> servers<span className="sep">·</span>
                <b>{running}</b> running<span className="sep">·</span>
                <b>{tools}</b> tools
              </div>
            </div>

            {gateway && <GatewayBar gateway={gateway} />}

            <div className="section-title">
              Active servers
              <span className="rt">
                <button className={`btn sm ${showCatalog ? '' : 'btn-accent'}`} onClick={() => { setShowCatalog((v) => !v); setAdding(null); }}>
                  {showCatalog ? 'Close' : '+ Add server'}
                </button>
              </span>
            </div>

            {servers && servers.length === 0 && !showCatalog ? (
              <div className="panel"><div className="empty">
                <div className="cat">🐈</div>
                <b>No servers yet.</b>
                <div className="small" style={{ marginTop: 4 }}>Add one — its tools join the gateway instantly.</div>
                <div style={{ marginTop: 14 }}><button className="btn btn-primary" onClick={() => setShowCatalog(true)}>+ Add your first server</button></div>
              </div></div>
            ) : servers && servers.length > 0 ? (
              <div className="panel"><div className="list">
                {servers.map((s) => <ServerRow key={s.id} s={s} agents={agents} onChange={refresh} />)}
              </div></div>
            ) : null}

            <ConnectedAgents agents={agents} servers={servers ?? []} onChange={refreshAgents} />

            <CliSection />

            {showCatalog && <AddCatalog curated={registry} onPick={handlePick} />}

            {adding && (
              <AddServer
                entry={adding === 'custom' ? null : adding}
                onClose={() => setAdding(null)}
                onAdded={() => { setAdding(null); setShowCatalog(false); void refresh(); }}
              />
            )}
          </>
        ) : view === 'analytics' ? (
          <AnalyticsView stats={stats} />
        ) : (
          <SettingsView gateway={gateway} version={version} />
        )}

        <div className="footer">
          <span>Local-first · MIT · Nekko Labs</span>
          <div className="spacer" style={{ flex: 1 }} />
          <a href="https://github.com/nekko-labs/hypergate" target="_blank" rel="noreferrer">nekko-labs/hypergate</a>
        </div>
      </div>
    </>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') as Theme) || 'medium');
  const set = (t: Theme) => {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('hypergate-theme', t); } catch { /* ignore */ }
  };
  const opts: [Theme, string, string][] = [['light', '☀', 'Light'], ['medium', '◐', 'Medium'], ['dark', '☾', 'Dark']];
  return (
    <div className="themeswitch" role="group" aria-label="Theme">
      {opts.map(([t, icon, label]) => (
        <button key={t} className={theme === t ? 'active' : ''} title={label} aria-label={label} onClick={() => set(t)}>{icon}</button>
      ))}
    </div>
  );
}

/**
 * The gateway endpoint itself: URL + the master token, and a pointer to the one
 * place that connects agents. The snippet tabs that used to live here are gone —
 * they handed out the full-access master token and duplicated what Connected
 * agents does better (a scoped, revocable token per client, installed for you).
 */
function GatewayBar({ gateway }: { gateway: GatewayInfo }) {
  const [copied, copy] = useCopy();
  const [showToken, setShowToken] = useState(false);
  const token = gateway.token ?? '';
  return (
    <div className="gwbar">
      <div className="gwbar-row">
        <span className="glabel"><span className="dot-grad" />Gateway</span>
        <span className="url">{gateway.url}</span>
        <button className="btn sm" onClick={() => copy('url', gateway.url)}>{copied === 'url' ? 'Copied!' : 'Copy'}</button>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="tok">master token {showToken ? token.slice(0, 12) + '…' : '••••••'}</span>
        <button className="btn sm btn-ghost" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</button>
        <button className="btn sm" onClick={() => copy('token', token)}>{copied === 'token' ? 'Copied!' : 'Copy'}</button>
      </div>
      <div className="gwbar-note">
        <span className="small muted">
          The master token reaches every server. To connect a client, give it its own scoped token in{' '}
          <b>Connected agents</b> — Hypergate can set it up in the client for you.
        </span>
        <a className="btn sm btn-accent" href="#agents">Connect an agent ↓</a>
      </div>
    </div>
  );
}

const STATE_PILL: Record<string, string> = {
  ready: 'pill-ready',
  starting: 'pill-starting',
  errored: 'pill-errored',
  stopped: 'pill-stopped',
  authorizing: 'pill-authorizing',
};

function ServerRow({ s, agents, onChange }: { s: ServerStatus; agents: AgentClientInfo[]; onChange: () => void }) {
  const [logs, setLogs] = useState<string[] | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const allowedBy = agents.filter((a) => a.servers === '*' || a.servers.includes(s.id)).length;
  const busy = s.state === 'starting';
  const isRemote = s.runtime === 'remote';
  const authorizing = s.state === 'authorizing';
  const act = async (action: 'start' | 'stop' | 'restart') => {
    await api.action(s.id, action).catch(() => {});
    onChange();
  };
  const signIn = async () => {
    const st = await api.authorize(s.id).catch(() => null);
    openAuth(st?.authUrl);
    onChange();
  };
  const disconnect = async () => {
    await api.disconnect(s.id).catch(() => {});
    onChange();
  };
  const toggleLogs = async () => {
    if (logs) return setLogs(null);
    setLogs((await api.logs(s.id).catch(() => ({ logs: [] }))).logs);
  };
  return (
    <div className="list-row">
      <div className="list-head between">
        <div className="row wrap-gap">
          <span className={`pill ${STATE_PILL[s.state] ?? 'pill-stopped'}`}><span className="dot" />{s.state}</span>
          <span className="server-name">{s.name}</span>
          <span className="chip">{RUNTIME_CHIP[s.runtime] ?? '⚡ process'}</span>
          {isRemote && s.url && <span className="chip mono" title={s.url}>{new URL(s.url).host}</span>}
          {s.state === 'ready' && (
            <button className="link-btn" onClick={() => setShowTools(!showTools)}>{s.tools.length} tools {showTools ? '▾' : '▸'}</button>
          )}
          {s.restarts > 0 && <span className="chip">{s.restarts} restarts</span>}
        </div>
        <div className="row">
          {authorizing ? (
            <button className="btn sm btn-primary" onClick={() => void signIn()}>🔐 Sign in</button>
          ) : s.state === 'ready' ? (
            <button className="btn sm btn-warn" onClick={() => void act('stop')}>Stop</button>
          ) : (
            <button className="btn sm btn-go" onClick={() => void act('start')} disabled={busy}>{busy ? 'Starting…' : 'Start'}</button>
          )}
          {!authorizing && <button className="btn sm btn-warn" onClick={() => void act('restart')}>Restart</button>}
          {isRemote && !authorizing && <button className="btn sm btn-warn" onClick={() => void disconnect()} title="Sign out and drop stored tokens">Disconnect</button>}
          {agents.length > 0 && (
            <button
              className={`btn sm ${showAgents ? '' : allowedBy === 0 ? 'btn-warn' : ''}`}
              onClick={() => setShowAgents(!showAgents)}
              title="Which connected agents may use this server"
            >
              Agents {allowedBy}/{agents.length} {showAgents ? '▴' : '▾'}
            </button>
          )}
          <button className="btn sm" onClick={() => void toggleLogs()}>Logs</button>
          <button className="btn sm btn-danger" onClick={() => { void api.remove(s.id).then(onChange); }}>Remove</button>
        </div>
      </div>
      {authorizing && (
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Waiting for sign-in. Click <b>Sign in</b> to open {s.name}'s login in a new window — it connects automatically once you authorize.
        </p>
      )}
      {s.error && !authorizing && <p className="small" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>{s.error}</p>}
      {showAgents && <ServerAgents server={s} agents={agents} onChange={onChange} />}
      {showTools && s.tools.length > 0 && (
        <ToolList serverId={s.id} tools={s.toolDetails ?? s.tools.map((name) => ({ name }))} />
      )}
      {logs && <pre className="logs">{logs.join('\n') || '(no output yet)'}</pre>}
    </div>
  );
}

/**
 * "Agents" panel on a server row: which connected agents may reach *this* server
 * through the gateway, one switch each. The same permission the agent rows edit,
 * read from the server's side, which is how you think about it when you've just
 * added a server and want only one agent to see it.
 *
 * An agent scoped to all servers shows on but says so: turning this server off
 * for it pins it to the servers that exist today (the daemon expands `'*'` into
 * that list), and quietly changing what "all servers" means later would be the
 * worse surprise.
 */
function ServerAgents({ server, agents, onChange }: { server: ServerStatus; agents: AgentClientInfo[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const flip = async (agent: AgentClientInfo, allowed: boolean) => {
    setBusy(agent.id);
    setErr(null);
    try {
      await api.setAgentServer(agent.id, server.id, allowed);
    } catch {
      setErr(`Could not change ${agent.name}'s access to ${server.name}.`);
    }
    setBusy(null);
    onChange();
  };
  const anyWildcard = agents.some((a) => a.servers === '*');
  return (
    <div className="perm-panel">
      <div className="small muted">
        Which connected agents may use <b>{server.name}</b> through the gateway. Off means its tools are hidden from
        that agent, and a call to them is refused.
      </div>
      {agents.map((a) => {
        const on = a.servers === '*' || a.servers.includes(server.id);
        return (
          <div key={a.id} className="perm-toggle-row">
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <span className="agent-dot" />
              <span className="setting-label">{a.name}</span>
              {a.servers === '*' ? (
                <span className="chip chip-accent">all servers</span>
              ) : (
                <span className="chip">{a.servers.length} server{a.servers.length === 1 ? '' : 's'}</span>
              )}
            </div>
            <button
              role="switch"
              aria-checked={on}
              aria-label={`${a.name} may use ${server.name}`}
              className={`toggle ${on ? 'on' : ''}`}
              disabled={busy === a.id}
              onClick={() => void flip(a, !on)}
            >
              <span className="knob" />
            </button>
          </div>
        );
      })}
      {anyWildcard && (
        <div className="small muted">
          Turning this off for an <b>all servers</b> agent pins that agent to the servers configured right now, so it
          won't automatically pick up ones you add later.
        </div>
      )}
      {err && <div className="small" style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

/** Clickable list of a server's tools; each row expands to its description + parameters. */
function ToolList({ serverId, tools }: { serverId: string; tools: ToolInfo[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="tool-list">
      {tools.map((t) => {
        const isOpen = open === t.name;
        return (
          <div key={t.name} className={`tool-item ${isOpen ? 'open' : ''}`}>
            <button className="tool-head" onClick={() => setOpen(isOpen ? null : t.name)}>
              <span className="tool-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="tool-name mono">{serverId}__{t.name}</span>
              {t.description && <span className="tool-desc small muted">{t.description}</span>}
            </button>
            {isOpen && (
              <div className="tool-detail">
                {t.description && <p className="tool-detail-desc">{t.description}</p>}
                <SchemaParams schema={t.inputSchema} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
  required?: string[];
}
/** Render an MCP tool's inputSchema as a compact parameter list. */
function SchemaParams({ schema }: { schema: unknown }) {
  const s = (schema && typeof schema === 'object' ? schema : {}) as JsonSchema;
  const props = s.properties ?? {};
  const names = Object.keys(props);
  const required = new Set(s.required ?? []);
  if (names.length === 0) return <div className="small muted tool-noparams">No parameters.</div>;
  return (
    <div className="params">
      <div className="params-label small muted">Parameters</div>
      {names.map((name) => {
        const p = props[name] ?? {};
        return (
          <div key={name} className="param-row">
            <span className="param-name mono">{name}</span>
            {p.type && <span className="param-type chip mono">{p.type}</span>}
            {required.has(name) && <span className="param-req">required</span>}
            {p.description && <span className="param-desc small muted">{p.description}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A labeled on/off switch row. */
function ToggleRow({
  label, desc, checked, disabled, onChange,
}: { label: string; desc: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="list-row setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        <div className="small muted">{desc}</div>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`toggle ${checked ? 'on' : ''}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

/** Service/desktop options: run at login, start minimized, stop the daemon. */
function SettingsView({ gateway, version }: { gateway: GatewayInfo | null; version: string }) {
  const [s, setS] = useState<SettingsInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api.settings().then(setS).catch(() => setErr('Could not load settings — is the daemon running?'));
  }, []);

  const update = async (patch: UpdateSettingsRequest, key: string) => {
    setBusy(key);
    setErr(null);
    try {
      setS(await api.updateSettings(patch));
    } catch {
      setErr('Could not save the setting, check the daemon logs.');
    }
    setBusy(null);
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="grad-text">Settings</span></h1>
          <p>How Hypergate runs on this machine. Local-first — these only affect your own device.</p>
        </div>
      </div>

      <div className="section-title">Startup &amp; desktop</div>
      <div className="panel">
        {!s ? (
          <div className="list-row small muted">Loading…</div>
        ) : (
          <div className="list">
            <ToggleRow
              label="Run on startup"
              desc={
                s.startupSupported
                  ? 'Launch Hypergate in the tray automatically when you sign in to Windows.'
                  : `Autostart isn't wired up on ${s.platform} yet — it's coming with the desktop shell.`
              }
              checked={s.runOnStartup}
              disabled={!s.startupSupported || busy === 'runOnStartup'}
              onChange={(v) => void update({ runOnStartup: v }, 'runOnStartup')}
            />
            <ToggleRow
              label="Start minimized"
              desc="Stay in the system tray on launch instead of opening the manager window."
              checked={s.startMinimized}
              disabled={busy === 'startMinimized'}
              onChange={(v) => void update({ startMinimized: v }, 'startMinimized')}
            />
          </div>
        )}
      </div>
      {err && <p className="small" style={{ color: 'var(--danger)', marginTop: 10 }}>{err}</p>}
      <p className="small muted" style={{ marginTop: 12 }}>
        Startup launches the tray app, which keeps the daemon running in the background. Right-click the tray icon for
        Open manager / Restart / Quit.
      </p>

      <div className="section-title" style={{ marginTop: 24 }}>
        This daemon
        {version && <span className="rt"><span className="chip">v{version}</span></span>}
      </div>
      <div className="panel"><div className="list">
        <StopDaemon gateway={gateway} />
      </div></div>
    </>
  );
}

/**
 * Stop the daemon from the UI: the one control here that ends the session it is
 * shown in, so it asks twice and then says what happened rather than leaving the
 * page to discover it went offline.
 *
 * The request carries the master gateway token (an agent's scoped token may call
 * tools, not take the runtime down) and the daemon answers before it exits, so a
 * result means the shutdown really was accepted.
 */
function StopDaemon({ gateway }: { gateway: GatewayInfo | null }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const stop = async () => {
    if (!gateway?.token) {
      setErr('No gateway token available. Reload the page and try again.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.shutdown(gateway.token);
      setStopped(r.servers);
      setConfirming(false);
    } catch {
      setErr('The daemon refused the request. Reload the page (the token may have changed) or stop it where it was started.');
    }
    setBusy(false);
  };

  if (stopped !== null) {
    return (
      <div className="list-row">
        <div className="setting-label">Daemon stopped</div>
        <div className="small muted" style={{ marginTop: 4 }}>
          {stopped === 0 ? 'No managed servers were running.' : `${stopped} managed server${stopped === 1 ? '' : 's'} stopped with it.`}{' '}
          Start it again from the tray menu (<b>Restart daemon</b>), by reopening the Hypergate app, or with{' '}
          <code>hypergate start</code>. This page reconnects on its own.
        </div>
      </div>
    );
  }

  return (
    <div className="list-row setting-row">
      <div className="setting-text">
        <div className="setting-label">Stop the daemon</div>
        <div className="small muted">
          Shuts down the gateway and every managed MCP server on this machine. Connected agents lose their tools until
          it starts again; nothing is deleted, and enabled servers come back with it.
        </div>
        {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
      </div>
      {confirming ? (
        <div className="row" style={{ flex: 'none' }}>
          <button className="btn sm btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" onClick={() => void stop()} disabled={busy}>
            {busy ? 'Stopping…' : 'Yes, stop it'}
          </button>
        </div>
      ) : (
        <button className="btn btn-danger" style={{ flex: 'none' }} onClick={() => setConfirming(true)}>Stop daemon</button>
      )}
    </div>
  );
}

function AnalyticsView({ stats }: { stats: AnalyticsSummary | null }) {
  const hasData = !!stats && stats.totalCalls > 0;
  const successRate = stats && stats.totalCalls > 0 ? Math.round(((stats.totalCalls - stats.totalErrors) / stats.totalCalls) * 100) : 100;
  const maxSeries = stats ? Math.max(1, ...stats.series.map((b) => b.calls)) : 1;
  const maxServer = stats ? Math.max(1, ...stats.servers.map((s) => s.calls)) : 1;
  const maxClient = stats ? Math.max(1, ...stats.clients.map((c) => c.calls)) : 1;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="grad-text">Analytics</span> &amp; visibility</h1>
          <p>Every tool call routed through the gateway, counted here — which server, which client, how much data. Local-first: nothing leaves your machine.</p>
        </div>
        {stats && <div className="summary">since <b>{fmtRel(stats.since)}</b></div>}
      </div>

      <div className="callout">
        <span className="ic">🔎</span>
        <div>
          <div className="t">Why route through Hypergate? You get an audit trail for free.</div>
          <div className="d">Point agents at one gateway and Hypergate records every call — per server, per client, per byte — so you can see exactly what your tools are doing. No dashboards to wire up, no data leaving localhost.</div>
        </div>
      </div>

      <div className="metricbar">
        <div className="metric accent"><div className="m-val">{fmtNum(stats?.totalCalls ?? 0)}</div><div className="m-label">tool calls</div></div>
        <div className="metric"><div className="m-val">{successRate}<span className="u">%</span></div><div className="m-label">success rate</div></div>
        <div className="metric"><div className="m-val">{stats?.clients.length ?? 0}</div><div className="m-label">clients</div></div>
        <div className="metric"><div className="m-val">{fmtBytes(stats?.bytesIn ?? 0)}</div><div className="m-label">data in</div></div>
        <div className="metric"><div className="m-val">{fmtBytes(stats?.bytesOut ?? 0)}</div><div className="m-label">data out</div></div>
      </div>

      {hasData ? (
        <>
          <div className="spark-wrap">
            <div className="small muted" style={{ marginBottom: 2 }}>Calls · last 24h</div>
            <div className="spark">
              {stats!.series.map((b, i) => (
                <div
                  key={i}
                  className={`spark-bar ${b.calls === 0 ? 'empty' : ''}`}
                  style={{ height: `${Math.max(4, (b.calls / maxSeries) * 100)}%` }}
                  title={`${new Date(b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${b.calls} calls`}
                />
              ))}
            </div>
            <div className="spark-axis"><span>24h ago</span><span>now</span></div>
          </div>

          <div className="section-title" style={{ marginTop: 24 }}>Usage by server</div>
          <div className="panel"><div className="list">
            {stats!.servers.map((s) => (
              <div key={s.serverId} className="list-row">
                <div className="row between wrap-gap">
                  <div><span className="server-name">{s.name}</span> <span className="small muted">{s.serverId}</span></div>
                  <div className="u-metrics">
                    <span><b>{fmtNum(s.calls)}</b> calls</span>
                    <span><b>{s.avgMs}</b>ms avg</span>
                    <span style={{ color: s.errors ? 'var(--danger)' : undefined }}><b>{s.errors}</b> err</span>
                    <span><b>{fmtBytes(s.bytesIn)}</b> in</span>
                    <span><b>{fmtBytes(s.bytesOut)}</b> out</span>
                  </div>
                </div>
                <div className="bar-track" style={{ marginTop: 9 }}><div className="bar-fill" style={{ width: `${(s.calls / maxServer) * 100}%` }} /></div>
                <div className="u-sub">
                  {s.tools.slice(0, 6).map((t) => <span key={t.tool} className="chip mono">{t.tool} ·{t.calls}</span>)}
                  <span style={{ marginLeft: 'auto' }}>{s.clients.length} client{s.clients.length === 1 ? '' : 's'} · last {fmtRel(s.lastUsed)}</span>
                </div>
              </div>
            ))}
          </div></div>

          <div className="section-title" style={{ marginTop: 24 }}>Who's calling</div>
          <div className="panel"><div className="list">
            {stats!.clients.map((c) => (
              <div key={c.client} className="list-row">
                <div className="row between wrap-gap">
                  <div className="server-name">{c.client}</div>
                  <div className="u-metrics">
                    <span><b>{fmtNum(c.calls)}</b> calls</span>
                    <span><b>{fmtBytes(c.bytesIn + c.bytesOut)}</b> data</span>
                    <span className="muted">{fmtRel(c.lastUsed)}</span>
                  </div>
                </div>
                <div className="bar-track" style={{ marginTop: 9 }}><div className="bar-fill" style={{ width: `${(c.calls / maxClient) * 100}%` }} /></div>
              </div>
            ))}
          </div></div>

          <div className="section-title" style={{ marginTop: 24 }}>Recent calls</div>
          <div className="panel"><div className="feed">
            {stats!.recent.map((e, i) => (
              <div key={i} className="feed-row">
                <span className="f-time">{fmtClock(e.at)}</span>
                <span className="f-call">{e.serverId}__{e.tool} <span className="f-client">· {e.client}</span></span>
                <span className="f-meta">
                  <span className={`ok-dot ${e.ok ? 'ok' : 'err'}`} title={e.ok ? 'ok' : e.error} />
                  {e.ms}ms · {fmtBytes(e.bytesIn + e.bytesOut)}
                </span>
              </div>
            ))}
          </div></div>
        </>
      ) : (
        <div className="panel" style={{ marginTop: 12 }}><div className="empty">
          <div className="cat">📡</div>
          <b>No calls yet.</b>
          <div className="small" style={{ marginTop: 4, maxWidth: 380, marginInline: 'auto' }}>
            Connect an agent to the gateway and start a server. Every tool call it makes will appear here — with the caller, latency, and data volume.
          </div>
        </div></div>
      )}
    </>
  );
}

function AddServer({ entry, onClose, onAdded }: { entry: RegistryEntry | null; onClose: () => void; onAdded: () => void }) {
  const [runtime, setRuntime] = useState<RuntimeKind>(entry?.runtime ?? 'process');
  const [name, setName] = useState(entry?.name ?? '');
  const [command, setCommand] = useState(entry?.command ?? '');
  const [args, setArgs] = useState((entry?.args ?? []).join(' '));
  const [image, setImage] = useState(entry?.image ?? '');
  const [env, setEnv] = useState((entry?.requires ?? []).map((k) => `${k}=`).join('\n'));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    const id = (entry?.id ?? (name || command)).replace(/[^a-z0-9-]/gi, '-').toLowerCase() + (entry ? '' : `-${Date.now() % 1000}`);
    const envObj: Record<string, string> = {};
    for (const line of env.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(i + 1).trim()) envObj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const cfg: ManagedServerConfig = {
      id,
      name: name || entry?.name || command,
      runtime,
      command,
      args: args.trim() ? args.trim().split(/\s+/) : [],
      env: Object.keys(envObj).length ? envObj : undefined,
      image: runtime === 'docker' ? image.trim() || entry?.image : undefined,
      enabled: true,
    };
    try {
      await api.add(cfg);
      onAdded();
    } catch (e) {
      setErr(e instanceof Error && e.message === '409' ? 'A server with that id already exists.' : 'Could not add the server, check the daemon logs.');
    }
    setBusy(false);
  };

  return (
    <section className="panel" style={{ marginTop: 14, padding: 18 }}>
      <div className="row between">
        <b>{entry ? `Add ${entry.name}` : 'Add a custom server'}</b>
        <button className="btn sm btn-ghost" onClick={onClose}>✕</button>
      </div>
      {entry && <p className="small muted" style={{ margin: '6px 0 0' }}>{entry.description}</p>}

      <div className="row" style={{ marginTop: 14, flexWrap: 'wrap', gap: 14 }}>
        <label className="field">
          Isolation
          <div className="seg">
            <button className={runtime === 'process' ? 'active' : ''} onClick={() => setRuntime('process')} title="Sandboxed child process — zero dependencies, lightest">⚡ Process sandbox</button>
            <button className={runtime === 'docker' ? 'active' : ''} onClick={() => setRuntime('docker')} title="Container per server — strongest isolation, needs Docker">🐳 Docker</button>
          </div>
        </label>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={entry?.name ?? 'my-server'} />
        </label>
      </div>
      {runtime === 'docker' && (
        <label className="field" style={{ marginTop: 12 }}>
          Image
          <input className="mono" value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/org/mcp-server:latest" />
        </label>
      )}
      <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 14 }}>
        <label className="field" style={{ minWidth: 140 }}>
          {runtime === 'docker' ? 'Command (optional — image entrypoint if blank)' : 'Command'}
          <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={runtime === 'docker' ? '(entrypoint)' : 'npx'} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 220 }}>
          Arguments
          <input className="mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ." />
        </label>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        Environment &amp; secrets (one KEY=value per line, never logged)
        <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={Math.max(2, env.split('\n').length)} />
      </label>
      <div className="row between" style={{ marginTop: 14 }}>
        <span className="small" style={{ color: 'var(--danger)' }}>{err}</span>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={(runtime === 'docker' ? !image && !command : !command) || busy}>{busy ? 'Adding…' : 'Add & start'}</button>
      </div>
    </section>
  );
}

/** One catalog row (curated or registry-search result) with an Add button. */
function CatalogRow({ e, onPick }: { e: RegistryEntry; onPick: (e: RegistryEntry) => void }) {
  const runnable = e.runnable !== false;
  const oauth = e.runtime === 'remote' && e.auth === 'oauth';
  return (
    <div className="list-row">
      <div className="row between wrap-gap">
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="row" style={{ gap: 8 }}>
            {e.recommended && <span className="rec-star" title="Recommended">★</span>}
            <span className="server-name">{e.name}</span>
            {e.official === true && (
              <span className="chip chip-official" title={e.publisher ? `Verified publisher: ${e.publisher}` : 'First-party / official server'}>✓ Official</span>
            )}
            {e.official === false && (
              <span className="chip" title={e.publisher ? `Community namespace: ${e.publisher}` : 'Community server (not first-party)'}>Community</span>
            )}
            <span className="chip">{RUNTIME_CHIP[e.runtime] ?? '⚡ process'}</span>
            {oauth && <span className="chip chip-accent">🔐 OAuth</span>}
            {e.source === 'registry' && <span className="chip chip-accent">registry</span>}
            {(e.requires ?? []).map((r) => <span key={r} className="chip mono">{r}</span>)}
          </div>
          {e.description && <div className="small muted" style={{ marginTop: 3 }}>{e.description}</div>}
          {e.note && <div className="small" style={{ marginTop: 3, color: 'var(--warning)' }}>{e.note}</div>}
        </div>
        <div className="row">
          {e.homepage && <a className="small muted" href={e.homepage} target="_blank" rel="noreferrer">docs</a>}
          <button className={`btn ${oauth ? 'btn-primary' : ''}`} onClick={() => onPick(e)} disabled={!runnable} title={runnable ? '' : e.note ?? 'Not locally runnable'}>
            {oauth ? '🔐 Sign in & add' : '+ Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "+ Add server" area: search the official MCP registry, or pick from the curated list. */
function AddCatalog({ curated, onPick }: { curated: RegistryEntry[]; onPick: (e: RegistryEntry | 'custom') => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RegistryEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  // Popularity is fetched here — i.e. only when the catalog is opened — so the
  // daemon never reaches out on boot. The recommended set shows first instantly
  // (authored order); the rest re-sort by popularity once it arrives.
  const [pop, setPop] = useState<PopularityMap>({});
  useEffect(() => { void api.popularity().then(setPop).catch(() => {}); }, []);
  const sortedCurated = useMemo(() => sortCatalog(curated, pop), [curated, pop]);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void api
        .searchRegistry(query)
        .then((r) => { if (mine === seq.current) setResults(r); })
        .catch(() => { if (mine === seq.current) setResults([]); })
        .finally(() => { if (mine === seq.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const searchingLive = q.trim().length > 0;
  return (
    <>
      <div className="section-title" style={{ marginTop: 22 }}>Add a server</div>
      <div className="panel">
        <div className="catalog-search">
          <span className="cs-ic">🔎</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the official MCP registry (github, postgres, slack…)"
          />
          {searching && <span className="small muted">searching…</span>}
          {q && <button className="btn sm btn-ghost" onClick={() => setQ('')}>Clear</button>}
        </div>
        <div className="list">
          {searchingLive ? (
            results && results.length > 0 ? (
              results.map((e) => <CatalogRow key={e.id} e={e} onPick={onPick} />)
            ) : !searching ? (
              <div className="list-row small muted">No servers found in the registry for “{q.trim()}”.</div>
            ) : (
              <div className="list-row small muted">Searching the MCP registry…</div>
            )
          ) : (
            <>
              {sortedCurated.map((e) => <CatalogRow key={e.id} e={e} onPick={onPick} />)}
              <div className="list-row">
                <div className="row between wrap-gap">
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <span className="server-name">Custom server</span>
                    <div className="small muted" style={{ marginTop: 3 }}>Any stdio MCP server, by command (process sandbox) or image (Docker).</div>
                  </div>
                  <button className="btn btn-primary" onClick={() => onPick('custom')}>+ Configure</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * "Connected agents" — the one place an agent gets connected. Each row is a
 * scoped gateway token with its per-server permissions, and its own Connect
 * panel: one click to have Hypergate run the client's `mcp add` for you, or the
 * exact command quoted for your shell if you'd rather run it yourself.
 */
function ConnectedAgents({ agents, servers, onChange }: { agents: AgentClientInfo[]; servers: ServerStatus[]; onChange: () => void }) {
  const [editing, setEditing] = useState<AgentClientInfo | 'new' | null>(null);
  /** Agent whose Connect panel is open, which client tab it opened on, and whether to install straight away. */
  const [connect, setConnect] = useState<{ id: string; target?: string; run?: boolean } | null>(null);
  const [targets, setTargets] = useState<ConnectTargetsInfo | null>(null);
  const [quick, setQuick] = useState<{ target: string; error?: string } | null>(null);

  useEffect(() => { void api.connectTargets().then(setTargets).catch(() => {}); }, []);

  // Quick connect: create the scoped agent and wire the client up in one go.
  // Re-clicking reuses the agent of the same name instead of stacking duplicates.
  const quickConnect = useCallback(async (t: ConnectTargetStatus) => {
    setQuick({ target: t.id });
    const agent = agents.find((a) => a.name === t.name) ?? (await api.addClient(t.name, '*').catch(() => null));
    if (!agent) {
      setQuick({ target: t.id, error: 'Could not create the agent — check the daemon logs.' });
      return;
    }
    onChange();
    // A detected CLI is genuinely one click: create, install, show the outcome.
    setConnect({ id: agent.id, target: t.id, run: t.method === 'cli' && t.found });
    setQuick(null);
  }, [agents, onChange]);

  const detected = (targets?.targets ?? []).filter((t) => t.method === 'cli' && t.found);
  return (
    <>
      <div className="section-title" id="agents" style={{ marginTop: 22 }}>
        Connected agents
        <span className="rt">
          <button className={`btn sm ${editing === 'new' ? '' : 'btn-accent'}`} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
            {editing === 'new' ? 'Close' : '+ Add agent'}
          </button>
        </span>
      </div>
      {agents.length === 0 && editing !== 'new' ? (
        <div className="panel"><div className="empty">
          <div className="cat">🔌</div>
          <b>No agents connected yet.</b>
          <div className="small" style={{ marginTop: 4, maxWidth: 460, marginInline: 'auto' }}>
            Every agent gets its own token, scoped to the servers you allow and revocable on its own.
            Pick a client and Hypergate sets it up{detected.length > 0 ? ' — one click, no config to edit' : ''}.
          </div>
          <div className="qc-grid">
            {(targets?.targets ?? []).map((t) => (
              <button key={t.id} className={`qc ${t.method === 'cli' && t.found ? 'qc-found' : ''}`} onClick={() => void quickConnect(t)}>
                <span className="qc-name">{t.name}</span>
                <span className="qc-state small">
                  {t.method !== 'cli'
                    ? 'config snippet'
                    : t.found
                      ? `detected${t.version ? ` · v${t.version}` : ''}`
                      : 'not installed'}
                </span>
              </button>
            ))}
          </div>
          {quick?.error && <div className="small" style={{ color: 'var(--danger)', marginTop: 10 }}>{quick.error}</div>}
          <div className="small muted" style={{ marginTop: 12 }}>
            Want to pick which servers it may reach? <button className="link-btn" onClick={() => setEditing('new')}>Add a scoped agent</button>
          </div>
        </div></div>
      ) : (
        <div className="panel"><div className="list">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              servers={servers}
              connect={connect?.id === a.id ? connect : null}
              onConnect={() => setConnect(connect?.id === a.id ? null : { id: a.id })}
              onEdit={() => setEditing(a)}
              onChange={onChange}
            />
          ))}
        </div></div>
      )}
      {editing && (
        <AgentEditor
          agent={editing === 'new' ? null : editing}
          servers={servers}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            onChange();
            // A brand-new agent isn't connected to anything yet — go straight to how.
            if (created) setConnect({ id: saved.id });
          }}
        />
      )}
    </>
  );
}

function AgentRow({
  agent, servers, connect, onConnect, onEdit, onChange,
}: {
  agent: AgentClientInfo;
  servers: ServerStatus[];
  connect: { id: string; target?: string; run?: boolean } | null;
  onConnect: () => void;
  onEdit: () => void;
  onChange: () => void;
}) {
  const [copied, copy] = useCopy();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const all = agent.servers === '*';
  const ids = agent.servers === '*' ? [] : agent.servers;
  /** Ids the agent still lists but that no longer exist, shown so they can be cleared. */
  const orphaned = ids.filter((id) => !servers.some((s) => s.id === id));
  const [permErr, setPermErr] = useState<string | null>(null);
  const flip = async (serverId: string, allowed: boolean) => {
    setBusy(serverId);
    setPermErr(null);
    try {
      await api.setAgentServer(agent.id, serverId, allowed);
    } catch {
      setPermErr('Could not change that permission. Check the daemon logs.');
    }
    setBusy(null);
    onChange();
  };
  return (
    <div className="list-row">
      <div className="list-head between">
        <div className="row wrap-gap">
          <span className="agent-dot" />
          <span className="server-name">{agent.name}</span>
          <span className="tok mono">{show ? agent.token.slice(0, 16) + '…' : '••••••'}</span>
          <button className="btn sm btn-ghost" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
          <button className="btn sm" onClick={() => copy(`tok-${agent.id}`, agent.token)}>{copied === `tok-${agent.id}` ? 'Copied!' : 'Copy token'}</button>
        </div>
        <div className="row">
          <span className="small muted">{agent.lastUsed ? `used ${fmtRel(agent.lastUsed)}` : 'never used'}</span>
          <button className={`btn sm ${connect ? '' : 'btn-accent'}`} onClick={onConnect}>Connect {connect ? '▴' : '▾'}</button>
          <button className="btn sm" onClick={onEdit}>Edit</button>
          <button className="btn sm btn-danger" onClick={() => { void api.removeClient(agent.id).then(onChange); }}>Remove</button>
        </div>
      </div>
      {/* Permissions are editable right here: one click per server, no dialog.
          The chips are the state and the control at once, so "what may this
          agent reach" and "change it" are the same place. */}
      <div className="perm-row">
        <span className="small muted">can use</span>
        {all && <span className="chip chip-accent" title="Including any server added later">all servers</span>}
        {servers.length === 0 ? (
          <span className="small muted">no servers configured yet</span>
        ) : (
          servers.map((s) => {
            const on = all || ids.includes(s.id);
            return (
              <button
                key={s.id}
                className={`chip chip-toggle ${on ? 'on' : 'off'}`}
                aria-pressed={on}
                disabled={busy === s.id}
                title={on ? `Click to block ${s.name} for ${agent.name}` : `Click to allow ${s.name} for ${agent.name}`}
                onClick={() => void flip(s.id, !on)}
              >
                {on ? '✓' : '✕'} {s.name}
              </button>
            );
          })
        )}
        {orphaned.map((id) => (
          <button
            key={id}
            className="chip chip-toggle on"
            aria-pressed
            disabled={busy === id}
            title="This server is no longer configured. Click to drop it from the list"
            onClick={() => void flip(id, false)}
          >
            ✓ {id} <span className="muted">(gone)</span>
          </button>
        ))}
        {!all && ids.length === 0 && (
          <span className="chip" style={{ color: 'var(--danger)' }}>blocked, no servers</span>
        )}
        {permErr && <span className="small" style={{ color: 'var(--danger)' }}>{permErr}</span>}
      </div>
      {connect && <AgentConnect agent={agent} initialTarget={connect.target} autoRun={connect.run} />}
    </div>
  );
}

const SHELL_LABEL: Record<ConnectShell, string> = { powershell: 'PowerShell', cmd: 'cmd.exe', bash: 'bash / zsh' };

/**
 * The connect panel for one agent: a tab per client, then either the one-click
 * install (we run the client's own `mcp add`) or the snippet to paste. The exact
 * command is always on screen — quoted for the shell you're actually in — so the
 * button is a shortcut, not a black box.
 */
function AgentConnect({ agent, initialTarget, autoRun }: { agent: AgentClientInfo; initialTarget?: string; autoRun?: boolean }) {
  const [info, setInfo] = useState<AgentConnectInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<string | undefined>(initialTarget);
  const [shell, setShell] = useState<ConnectShell | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [copied, copy] = useCopy();
  /** Guards the quick-connect auto-install so a re-render can't fire it twice. */
  const ran = useRef(false);

  const run = useCallback(async (targetId: string) => {
    setBusy(true);
    setResult(null);
    const r = await api.connect(agent.id, targetId).catch(() => null);
    setResult(r ?? { ok: false, target: targetId, command: '', output: '', error: 'The daemon could not run the command.' });
    setBusy(false);
  }, [agent.id]);

  useEffect(() => {
    setFailed(false);
    void api
      .connectInfo(agent.id)
      .then((i) => {
        setInfo(i);
        setShell((s) => s ?? i.defaultShell);
        setTab((t) => t ?? i.targets.find((x) => x.method === 'cli' && x.found)?.id ?? i.targets[0]?.id);
        if (autoRun && initialTarget && !ran.current) {
          ran.current = true;
          void run(initialTarget);
        }
      })
      .catch(() => setFailed(true));
  }, [agent.id, autoRun, initialTarget, run]);

  if (failed) return <div className="connect-panel small" style={{ color: 'var(--danger)' }}>Could not load connect options — is the daemon still running?</div>;
  if (!info || !shell) return <div className="connect-panel small muted">Loading connect options…</div>;

  const t = info.targets.find((x) => x.id === tab);
  return (
    <div className="connect-panel">
      <div className="tabs">
        {info.targets.map((x) => (
          <button key={x.id} className={`tab ${x.id === tab ? 'active' : ''}`} onClick={() => { setTab(x.id); setResult(null); }}>
            {x.name}
            {x.method === 'cli' && x.found && <span className="tab-dot" title="Installed on this machine" />}
          </button>
        ))}
      </div>

      {t && (
        <div className="conn-body">
          {t.hint && <div className="small muted">{t.hint}</div>}

          {t.method === 'cli' ? (
            <>
              <div className="row wrap-gap" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" disabled={!t.found || busy} onClick={() => void run(t.id)}>
                  {busy ? 'Connecting…' : `⚡ Connect ${t.name}`}
                </button>
                {t.found ? (
                  <span className="small muted">
                    Runs the command below and registers it as <code>{info.entryName}</code>, replacing any earlier entry of that name.
                  </span>
                ) : (
                  <span className="small" style={{ color: 'var(--warning)' }}>
                    <code>{t.command}</code> isn't on your PATH{t.install ? <> — install with <code>{t.install}</code></> : null}.
                  </span>
                )}
              </div>
              <div className="shellbar">
                <span className="small muted">or run it yourself in</span>
                <div className="seg">
                  {info.shells.map((s) => (
                    <button key={s} className={shell === s ? 'active' : ''} onClick={() => setShell(s)}>{SHELL_LABEL[s]}</button>
                  ))}
                </div>
                <div className="spacer" style={{ flex: 1 }} />
                <button className="btn sm" onClick={() => copy('cmd', t.commands?.[shell] ?? '')}>{copied === 'cmd' ? 'Copied!' : 'Copy command'}</button>
              </div>
              <pre className="snippet">{t.commands?.[shell]}</pre>
            </>
          ) : (
            <>
              {t.configPath && (
                <div className="row wrap-gap" style={{ marginTop: 10 }}>
                  <span className="small muted">Paste into</span>
                  <code className="path">{t.configPath}</code>
                  <div className="spacer" style={{ flex: 1 }} />
                  <button className="btn sm" onClick={() => copy('snip', t.snippet ?? '')}>{copied === 'snip' ? 'Copied!' : 'Copy snippet'}</button>
                </div>
              )}
              <pre className="snippet">{t.snippet}</pre>
            </>
          )}

          {result && (
            <div className={`conn-result ${result.ok ? 'ok' : 'err'}`}>
              <b>{result.ok ? `✓ Connected — ${info.entryName} is registered.` : result.error ?? 'That did not work.'}</b>
              {result.ok && <span className="small"> Restart the client if it was already running.</span>}
              {result.output && <pre className="snippet">{result.output}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentEditor({
  agent, servers, onClose, onSaved,
}: {
  agent: AgentClientInfo | null;
  servers: ServerStatus[];
  onClose: () => void;
  /** `created` is true for a brand-new agent, which still needs connecting. */
  onSaved: (saved: AgentClientInfo, created: boolean) => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [all, setAll] = useState(agent ? agent.servers === '*' : true);
  const [sel, setSel] = useState<Set<string>>(new Set(agent && agent.servers !== '*' ? agent.servers : []));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!name.trim()) { setErr('Give the agent a name.'); return; }
    setErr(null);
    setBusy(true);
    const scoped: '*' | string[] = all ? '*' : [...sel];
    try {
      const saved = agent
        ? await api.updateClient(agent.id, { name: name.trim(), servers: scoped })
        : await api.addClient(name.trim(), scoped);
      onSaved(saved, !agent);
    } catch {
      setErr('Could not save the agent, check the daemon logs.');
    }
    setBusy(false);
  };

  return (
    <section className="panel" style={{ marginTop: 14, padding: 18 }}>
      <div className="row between">
        <b>{agent ? `Edit ${agent.name}` : 'Add a connected agent'}</b>
        <button className="btn sm btn-ghost" onClick={onClose}>✕</button>
      </div>
      <label className="field" style={{ marginTop: 14, maxWidth: 320 }}>
        Agent name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. research-bot" />
      </label>

      <div className="field" style={{ marginTop: 14 }}>
        Allowed servers
        <label className="perm-check" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span><b>All servers</b> <span className="small muted">— including any added later</span></span>
        </label>
        {!all && (
          <div className="perm-list">
            {servers.length === 0 && <div className="small muted">No servers yet — add a server first, then scope this agent to it.</div>}
            {servers.map((s) => (
              <label key={s.id} className="perm-check">
                <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} />
                <span>{s.name} <span className="small muted mono">{s.id}</span></span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="row between" style={{ marginTop: 14 }}>
        <span className="small" style={{ color: 'var(--danger)' }}>{err}</span>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : agent ? 'Save' : 'Create agent'}</button>
      </div>
    </section>
  );
}

/**
 * "Command-line tools": which CLIs are installed on this machine (many MCP
 * servers need one — `uvx` for Python servers, `docker` for the Docker runtime,
 * `flyctl` for Fly, `kotrain` for the Kotrain server) plus a quick search to
 * check any command. Local + shell-free; nothing leaves the machine.
 */
function CliSection() {
  const [clis, setClis] = useState<CliStatus[] | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [check, setCheck] = useState<CliCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    void api.clis().then(setClis).catch(() => setClis([]));
  }, []);

  // Debounced ad-hoc availability check, so you can look up a command that isn't
  // in the known list (psql, terraform, …), not just filter the known ones.
  useEffect(() => {
    const name = q.trim();
    setCheck(null);
    if (!name) { setChecking(false); return; }
    setChecking(true);
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void api
        .checkCli(name)
        .then((r) => { if (mine === seq.current) setCheck(r); })
        .catch(() => { if (mine === seq.current) setCheck(null); })
        .finally(() => { if (mine === seq.current) setChecking(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const found = clis?.filter((c) => c.found).length ?? 0;
  const total = clis?.length ?? 0;
  const query = q.trim().toLowerCase();
  const filtered = (clis ?? []).filter(
    (c) => !query || c.name.toLowerCase().includes(query) || c.command.toLowerCase().includes(query) || c.description.toLowerCase().includes(query),
  );
  const knownExact = (clis ?? []).some((c) => c.command.toLowerCase() === query);
  const showAdhoc = query.length > 0 && !knownExact;

  return (
    <>
      <div className="section-title">
        Command-line tools
        <span className="rt">
          {clis && <span className="small muted" style={{ marginRight: 8 }}>{found}/{total} detected</span>}
          <button className="btn sm" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</button>
        </span>
      </div>
      {open && (
        <div className="panel">
          <div className="catalog-search">
            <span className="cs-ic">🔎</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Check if a command is installed (docker, uvx, terraform…)" />
            {checking && <span className="small muted">checking…</span>}
            {q && <button className="btn sm btn-ghost" onClick={() => setQ('')}>Clear</button>}
          </div>
          <div className="list">
            {!clis ? (
              <div className="list-row small muted">Detecting installed tools…</div>
            ) : (
              <>
                {showAdhoc && <CliCheckRow name={q.trim()} result={check} checking={checking} />}
                {filtered.map((c) => <CliRow key={c.id} c={c} />)}
                {filtered.length === 0 && !showAdhoc && <div className="list-row small muted">No known tools match “{q.trim()}”.</div>}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function CliRow({ c }: { c: CliStatus }) {
  return (
    <div className="list-row">
      <div className="row between wrap-gap">
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="row wrap-gap" style={{ gap: 8 }}>
            <span className={`pill ${c.found ? 'pill-ready' : 'pill-stopped'}`}><span className="dot" />{c.found ? 'installed' : 'missing'}</span>
            <span className="server-name">{c.name}</span>
            <span className="chip mono">{c.command}</span>
            <span className="chip">{c.category}</span>
            {c.found && c.version && <span className="small muted">v{c.version}</span>}
          </div>
          {c.description && <div className="small muted" style={{ marginTop: 3 }}>{c.description}</div>}
          {c.found && c.path && <div className="small muted mono" style={{ marginTop: 3, wordBreak: 'break-all' }}>{c.path}</div>}
          {!c.found && c.install && <div className="small" style={{ marginTop: 3, color: 'var(--warning)' }}>Install: {c.install}</div>}
        </div>
        {c.homepage && (
          <div className="row"><a className="small muted" href={c.homepage} target="_blank" rel="noreferrer">docs</a></div>
        )}
      </div>
    </div>
  );
}

/** The ad-hoc "is this command available?" result row (for a command not in the known list). */
function CliCheckRow({ name, result, checking }: { name: string; result: CliCheckResult | null; checking: boolean }) {
  return (
    <div className="list-row cli-check">
      <div className="row wrap-gap" style={{ gap: 8 }}>
        {checking || !result ? (
          <span className="small muted">Checking <span className="mono">{name}</span>…</span>
        ) : result.found ? (
          <>
            <span className="pill pill-ready"><span className="dot" />installed</span>
            <span className="server-name mono">{name}</span>
            {result.version && <span className="small muted">v{result.version}</span>}
            {result.path && <span className="small muted mono" style={{ wordBreak: 'break-all' }}>{result.path}</span>}
          </>
        ) : (
          <>
            <span className="pill pill-stopped"><span className="dot" />not found</span>
            <span className="server-name mono">{name}</span>
            <span className="small muted">not on your PATH</span>
          </>
        )}
      </div>
    </div>
  );
}
