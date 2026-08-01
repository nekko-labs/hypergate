import { useEffect, useState, useCallback, useId, useRef, useMemo } from 'react';
import type { ReactNode } from 'react';
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
  UpdateInfo,
  UpdateProgress,
  InstallChannel,
  CloseAction,
} from '@hypergate/shared';
import { mergeCatalogSearch } from '@hypergate/shared';
import { api } from './api';
import { Dialog } from './components/Dialog';
import { EmptyState } from './components/EmptyState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LogConsole } from './components/LogConsole';
import { useToast } from './toast';

type View = 'servers' | 'analytics' | 'settings';
type ServerSection = 'agents' | 'mcp-servers' | 'cli';
type Theme = 'light' | 'medium' | 'dark';

const SERVER_SECTIONS: { id: ServerSection; label: string }[] = [
  { id: 'agents', label: 'Connected agents' },
  { id: 'mcp-servers', label: 'MCP servers' },
  { id: 'cli', label: 'CLI tools' },
];

/**
 * The two hooks the native manager window and this page use to talk.
 *
 * `__hypergateAskClose` is ours, registered by {@link CloseChoice}: the shell
 * calls it instead of closing when it doesn't yet know what the close button
 * should do. `ipc` is wry's, and carries the answer back. Neither exists in a
 * browser, which is exactly why the prompt only ever appears in the app.
 */
interface HypergateWindow extends Window {
  __hypergateAskClose?: () => void;
  ipc?: { postMessage: (message: string) => void };
}

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const toast = useToast();
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.show('Copied to clipboard', 'success'),
      () => toast.show('Could not copy to clipboard', 'error'),
    );
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  }, [toast]);
  return [copied, copy];
}

/**
 * Bring a panel that has just appeared into the view's scroll window. The view
 * only scrolls when the panels have run out of height to give up, but when it
 * does, a form opened by a button press must not land below the fold.
 */
function useRevealOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    // `nearest`, and not smooth: scroll the least that works, in one frame. A
    // window that isn't on screen never runs a smooth scroll to completion.
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return ref;
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

/**
 * Open a provider's OAuth sign-in, wherever this page happens to be running.
 *
 * In the desktop app there is no second window to open one into, so the shell
 * takes the URL over IPC and launches the user's real browser — which is where
 * they are already signed in to GitHub, and where they can see the address
 * they are handing a password to. In a browser tab a popup is the polite
 * option: the manager stays visible behind it and closing the popup is
 * obviously the way back.
 */
const reserveAuthWindow = (): Window | null => {
  if ((window as HypergateWindow).ipc) return null;
  const popup = window.open('', 'hypergate-oauth', 'width=600,height=760');
  if (popup) popup.opener = null;
  return popup;
};

const openAuth = (authUrl?: string, popup?: Window | null): void => {
  if (!authUrl) {
    popup?.close();
    return;
  }
  const ipc = (window as HypergateWindow).ipc;
  if (ipc) {
    ipc.postMessage(`open:${authUrl}`);
    return;
  }
  if (popup && !popup.closed) {
    popup.location.assign(authUrl);
    popup.focus();
    return;
  }
  window.open(authUrl, 'hypergate-oauth', 'width=600,height=760,noopener');
};

const RUNTIME_CHIP: Record<string, string> = { docker: '🐳 docker', remote: '🌐 remote', process: '⚡ process' };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Every state the update flow can be in, as one word. The topbar and the
 * Settings row render the same value, so they can never disagree about whether
 * something is downloading.
 */
type UpdateStageUi =
  | 'unknown'      // haven't asked yet
  | 'idle'         // nothing on offer
  | 'checking'
  | 'available'    // there is one, not downloaded
  | 'downloading'
  | 'staged'       // downloaded, waiting to be installed
  | 'installing'
  | 'installed'    // this session came up out of an update
  | 'failed';

export interface Updater {
  info: UpdateInfo | null;
  stage: UpdateStageUi;
  progress: UpdateProgress | null;
  error: string | null;
  check: (force?: boolean) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
  unskip: () => Promise<void>;
  dismissResult: () => void;
}

/**
 * The update flow, in one place.
 *
 * Two things here are worth knowing. First, **the check never flashes**: a
 * cached answer comes back in a few milliseconds, and a spinner that appears
 * and vanishes inside one frame reads as a glitch rather than as work, so the
 * checking state is held for a beat whatever the daemon does.
 *
 * Second, **the install outlives the daemon reporting it**. The updater has to
 * stop the daemon to replace its files, so progress polling starts failing
 * mid-install by design; that is treated as "still installing" rather than as
 * an error, and the answer arrives when a daemon comes back and says which
 * version it is.
 */
function useUpdater(gateway: GatewayInfo | null): Updater {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A skip pressed a moment ago, so the offer goes away before the daemon has
  // finished writing the setting down.
  const [skippedNow, setSkippedNow] = useState<string | null>(null);
  // The version that was serving when this page loaded. An install ends when
  // something else answers, and that is the only thing to compare against.
  const bootVersion = useRef<string | undefined>(undefined);

  const check = useCallback(async (force = false) => {
    setChecking(true);
    setError(null);
    // The floor, not a delay: whichever finishes last wins, so a slow daemon is
    // never made slower and a fast one is still legible.
    const [next] = await Promise.all([api.checkUpdate(force).catch(() => null), sleep(500)]);
    if (next) setInfo(next);
    if (force) setSkippedNow(null);
    setChecking(false);
  }, []);

  // What the last update did, asked once. The daemon clears it on read, so a
  // reload doesn't keep congratulating you for the same update.
  useEffect(() => {
    void api.health().then((h) => { bootVersion.current = h.version; }).catch(() => {});
    void api
      .updateResult()
      .then((r) => {
        if (r.ok && r.version) setInstalled(r.version);
        else if (r.version && r.error) setError(r.error);
      })
      .catch(() => {});
    void api.updateProgress().then(setProgress).catch(() => {});
  }, []);

  // Watch a running job. Polling stops when nothing is happening, so the idle
  // manager makes no requests it doesn't need.
  const active = progress?.stage === 'downloading' || progress?.stage === 'installing';
  const installing = progress?.stage === 'installing';
  useEffect(() => {
    if (!active) return;
    let live = true;

    /**
     * Has a *different* daemon come up in place of the one we were talking to?
     *
     * This is the only reliable end to an install, because the install replaces
     * the daemon reporting it: the request may fail (it's down), or succeed
     * against the new build (which knows nothing about the job). Either way the
     * answer is the same question — what version is serving now.
     */
    const replaced = async (): Promise<boolean> => {
      const h = await api.health().catch(() => null);
      return !!h?.version && h.version !== bootVersion.current;
    };

    const tick = async (): Promise<void> => {
      try {
        const p = await api.updateProgress();
        if (!live) return;
        // A new daemon answers happily and reports an idle job, so a successful
        // poll is not proof the install is still running.
        if (installing && (await replaced())) {
          if (live) window.location.reload();
          return;
        }
        if (!live) return;
        setProgress(p);
        if (p.stage === 'staged') void api.update().then(setInfo).catch(() => {});
        if (p.stage === 'error') setError(p.error ?? 'the update failed');
      } catch {
        // Gone quiet mid-install is the install working. Keep showing the
        // installing state and wait for whatever comes back.
        if (live && installing && (await replaced()) && live) window.location.reload();
      }
    };
    const t = setInterval(() => void tick(), 400);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [active, installing]);

  const token = gateway?.token;
  const guard = async (fn: (t: string) => Promise<unknown>): Promise<void> => {
    if (!token) {
      setError('No gateway token — reload the page and try again.');
      return;
    }
    setError(null);
    try {
      await fn(token);
      setProgress(await api.updateProgress().catch(() => null));
    } catch {
      setError('The daemon refused the request. Check ~/.hypergate/update.log for what it saw.');
    }
  };

  const download = useCallback(() => guard((t) => api.downloadUpdate(t)), [token]);
  const install = useCallback(() => guard((t) => api.applyUpdate(t)), [token]);

  const skip = useCallback(async () => {
    const v = info?.latest;
    if (!v) return;
    setSkippedNow(v);
    setInfo(await api.updateSettings({ skippedUpdate: v }).then(() => api.update()).catch(() => info));
  }, [info]);

  const unskip = useCallback(async () => {
    setSkippedNow(null);
    setInfo(await api.updateSettings({ skippedUpdate: null }).then(() => api.update()).catch(() => info));
  }, [info]);

  const stage: UpdateStageUi = checking
    ? 'checking'
    : installed
      ? 'installed'
      : progress?.stage === 'downloading'
        ? 'downloading'
        : progress?.stage === 'installing'
          ? 'installing'
          : progress?.stage === 'error' || (error && info?.updateAvailable)
            ? 'failed'
            : !info
              ? 'unknown'
              : info.updateAvailable && info.skipped !== info.latest && skippedNow !== info.latest
                ? info.staged === info.latest
                  ? 'staged'
                  : 'available'
                : 'idle';

  return { info, stage, progress, error, check, download, install, skip, unskip, dismissResult: () => setInstalled(null) };
}

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
  const toast = useToast();
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
  const [activeSection, setActiveSection] = useState<ServerSection>('agents');
  const viewRef = useRef<HTMLElement>(null);

  const refreshAgents = useCallback(() => {
    void api.clients().then(setAgents).catch(() => {});
  }, []);

  // The whole update flow: state, the buttons' actions, and the polling that
  // watches a running one. Shared, so the topbar and Settings can't disagree.
  const updater = useUpdater(gateway);
  const { check: checkUpdate } = updater;

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
    void checkUpdate();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh, checkUpdate]);

  const running = servers?.filter((s) => s.state === 'ready').length ?? 0;
  const tools = servers?.reduce((n, s) => n + s.tools.length, 0) ?? 0;

  // One-click OAuth: add the remote server and pop the provider's login. No form,
  // no token to paste — the whole point of the feature. Falls back to /authorize
  // if the server was already added (e.g. a half-finished earlier attempt).
  const quickAddOAuth = useCallback(async (e: RegistryEntry) => {
    const popup = reserveAuthWindow();
    setShowCatalog(false);
    setAdding(null);
    try {
      const status = await api.add({
        id: e.id, name: e.name, runtime: 'remote', command: '',
        url: e.url, transport: e.transport ?? 'http', auth: 'oauth', enabled: true,
      });
      openAuth(status.authUrl, popup);
      toast.show(`Added ${e.name} — finish signing in to connect`, 'success');
    } catch {
      // Already added (409) or a transient error — (re)start the login instead.
      const status = await api.authorize(e.id).catch(() => null);
      openAuth(status?.authUrl, popup);
      if (!status?.authUrl) toast.show(`Could not start sign-in for ${e.name}`, 'error');
    }
    void refresh();
  }, [refresh, toast]);

  const handlePick = useCallback((e: RegistryEntry | 'custom') => {
    if (e !== 'custom' && e.runtime === 'remote' && e.auth === 'oauth') { void quickAddOAuth(e); return; }
    setAdding(e);
  }, [quickAddOAuth]);

  const openView = useCallback((next: View) => {
    setView(next);
    requestAnimationFrame(() => viewRef.current?.scrollTo({ top: 0 }));
  }, []);

  const scrollToSection = useCallback((id: ServerSection) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  }, []);

  useEffect(() => {
    const root = viewRef.current;
    if (view !== 'servers' || !root) return;
    const sections = SERVER_SECTIONS.map(({ id }) => document.getElementById(id)).filter((section): section is HTMLElement => !!section);
    const update = () => {
      const marker = root.getBoundingClientRect().top + Math.min(180, root.clientHeight * 0.28);
      let current = sections[0]?.id as ServerSection | undefined;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= marker) current = section.id as ServerSection;
      }
      if (current) setActiveSection(current);
    };
    update();
    root.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    sections.forEach((section) => resize.observe(section));
    return () => {
      root.removeEventListener('scroll', update);
      resize.disconnect();
    };
  }, [view, agents.length, servers?.length, showCatalog, adding]);

  return (
    <div className="app">
      <CloseChoice />
      <header className="topbar">
        <div className="topbar-in">
          <GateMark />
          <span className="wordmark">Hypergate</span>
          <VersionBox version={version} u={updater} onOpenUpdates={() => openView('settings')} />
          <div className="spacer" />
          <ThemeSwitch />
          <ServerHealth offline={offline} gateway={gateway} />
        </div>
      </header>

      <div className="app-main">
        <aside className="side-rail">
          <nav className="nav" aria-label="Primary navigation">
            {(['servers', 'analytics', 'settings'] as View[]).map((item) => (
              <div className="nav-group" key={item}>
                <button
                  className={view === item ? 'active' : ''}
                  aria-current={view === item ? 'page' : undefined}
                  onClick={() => openView(item)}
                >
                  <NavIcon view={item} />
                  <span className="nav-label">{item === 'servers' ? 'Servers' : item[0].toUpperCase() + item.slice(1)}</span>
                  {item === 'analytics' && stats && stats.totalCalls > 0 && <span className="n-badge">{fmtNum(stats.totalCalls)}</span>}
                </button>
                {item === 'servers' && view === 'servers' && (
                  <div className="section-nav" aria-label="Servers sections">
                    {SERVER_SECTIONS.map((section) => (
                      <button
                        key={section.id}
                        className={activeSection === section.id ? 'active' : ''}
                        aria-current={activeSection === section.id ? 'location' : undefined}
                        onClick={() => scrollToSection(section.id)}
                      >
                        {section.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
        </aside>

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

          <main ref={viewRef} className={`view ${view === 'servers' ? 'servers-view' : ''}`}>
            <ErrorBoundary key={view} surface={`${view} view`}>
              {view === 'servers' ? (
                <>
                <div className="pagehead">
                  <div className="pagehead-copy">
                    <h1>Every MCP server. <span className="grad-text">One endpoint.</span></h1>
                    <p>Connect your agents, choose what they can reach, and keep every local tool visible through one gateway.</p>
                  </div>
                  <div className="pagehead-meta">
                    {gateway && <GatewayBar gateway={gateway} />}
                    <div className="summary">
                      <b>{agents.length}</b> agents<span className="sep">·</span>
                      <b>{running}</b> running<span className="sep">·</span>
                      <b>{tools}</b> tools
                    </div>
                  </div>
                </div>

                <section id="agents" className="dashboard-section">
                  <ConnectedAgents agents={agents} servers={servers ?? []} onChange={refreshAgents} />
                </section>

                <section id="mcp-servers" className="dashboard-section">
                  <div className="section-title">
                    MCP servers
                    <span className="rt">
                      <button className={`btn sm ${showCatalog ? '' : 'btn-accent'}`} onClick={() => { setShowCatalog((v) => !v); setAdding(null); }}>
                        {showCatalog ? 'Close' : '+ Add server'}
                      </button>
                    </span>
                  </div>

                  {servers === null && !showCatalog ? (
                    <EmptyState glyph="🐈" title="Loading servers…" loading>
                      Talking to the daemon.
                    </EmptyState>
                  ) : servers?.length === 0 && !showCatalog ? (
                    <EmptyState
                      glyph="🐈"
                      title="No servers yet."
                      action={<button className="btn btn-primary" onClick={() => setShowCatalog(true)}>+ Add your first server</button>}
                    >
                      Add one. Its tools join the gateway instantly.
                    </EmptyState>
                  ) : servers && servers.length > 0 ? (
                    <div className="panel"><div className="list">
                      {servers.map((s) => <ServerRow key={s.id} s={s} agents={agents} onChange={refresh} />)}
                    </div></div>
                  ) : null}

                  {showCatalog && <AddCatalog curated={registry} onPick={handlePick} />}

                  {adding && (
                    <AddServer
                      entry={adding === 'custom' ? null : adding}
                      onClose={() => setAdding(null)}
                      onAdded={() => { setAdding(null); setShowCatalog(false); void refresh(); }}
                    />
                  )}
                </section>

                <section id="cli" className="dashboard-section">
                  <CliSection />
                </section>
                </>
              ) : view === 'analytics' ? (
                <AnalyticsView stats={stats} />
              ) : (
                <SettingsView gateway={gateway} version={version} u={updater} />
              )}
            </ErrorBoundary>
          </main>

          <div className="footer">
            <span>
              Local-first · MIT · made with <Heart /> by Nekko Labs Community
            </span>
            <div className="spacer" style={{ flex: 1 }} />
            <a
              className="foot-gh"
              href="https://github.com/nekko-labs/hypergate"
              target="_blank"
              rel="noreferrer"
              title="nekko-labs/hypergate on GitHub"
              aria-label="Hypergate on GitHub"
            >
              <GitHubMark />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "What should the close button do?" — asked once, in the window being closed.
 *
 * Closing a desktop app usually means *close*, but closing this one could also
 * mean stopping a gateway that other agents are mid-call on. Both readings are
 * reasonable, so the first close asks instead of guessing, and the answer is
 * kept (changeable later in Settings → Startup & desktop).
 *
 * The shell drives it: on a close request with no preference recorded it calls
 * `__hypergateAskClose()` rather than closing, and waits for the answer over
 * wry's IPC channel. In a browser tab neither side exists, so nothing here ever
 * fires — the browser's own close button is the browser's business.
 */
function CloseChoice() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const reply = (message: string): void => (window as HypergateWindow).ipc?.postMessage(message);

  useEffect(() => {
    const w = window as HypergateWindow;
    w.__hypergateAskClose = () => {
      setOpen(true);
      // Tell the shell the question is on screen. It gives up and closes the
      // window if nothing answers — a page that failed to load must not be able
      // to trap it — and that deadline has to stop running the moment there is
      // a human reading the dialog.
      w.ipc?.postMessage('close:asking');
    };
    return () => { delete w.__hypergateAskClose; };
  }, []);

  const decide = async (action: 'tray' | 'quit') => {
    setBusy(true);
    // Save first: if the window is about to go away, the answer must already be
    // on disk, or the next close asks all over again.
    await api.updateSettings({ closeAction: action }).catch(() => {});
    setBusy(false);
    setOpen(false);
    reply(`close:${action}`);
  };

  const cancel = () => {
    setOpen(false);
    reply('close:cancel');
  };

  if (!open) return null;
  return (
    <Dialog
      title={<><span className="modal-mark" aria-hidden="true">🐾</span>When you close this window…</>}
      onClose={cancel}
      width={520}
      description={<>Hypergate can stay in the tray with the gateway running, so your agents keep their tools — or shut down completely. We'll remember which you pick; you can change it in <b>Settings → Startup &amp; desktop</b>.</>}
    >
      <div className="modal-choices">
        <button className="choice" disabled={busy} onClick={() => void decide('tray')}>
          <span className="choice-t">Keep running in the tray</span>
          <span className="choice-d small muted">The window closes. The gateway and every managed server stay up.</span>
        </button>
        <button className="choice choice-warn" disabled={busy} onClick={() => void decide('quit')}>
          <span className="choice-t">Quit and stop the server</span>
          <span className="choice-d small muted">Closes the window, stops the gateway, and stops every managed server.</span>
        </button>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn sm btn-ghost" onClick={cancel} disabled={busy}>Don't close</button>
      </div>
    </Dialog>
  );
}

/** A small filled heart, standing in for the word "love" in the footer. */
function Heart() {
  return (
    <svg
      className="heart" viewBox="0 0 24 24" width="12" height="12"
      aria-label="love" role="img" fill="currentColor"
    >
      <path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z" />
    </svg>
  );
}

function NavIcon({ view }: { view: View }) {
  if (view === 'servers') {
    return <svg className="nav-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12v4H4zM4 11.5h12v4H4z" /><path d="M6.5 6.5h.01M6.5 13.5h.01" /></svg>;
  }
  if (view === 'analytics') {
    return <svg className="nav-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 15.5V11m6 4.5v-11m6 11V8" /></svg>;
  }
  return <svg className="nav-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 2.5v2m0 11v2m7.5-7.5h-2m-11 0h-2m12.8-5.3-1.4 1.4M6.1 13.9l-1.4 1.4m10.6 0-1.4-1.4M6.1 6.1 4.7 4.7" /></svg>;
}

/**
 * The gate, turning.
 *
 * The marketing site draws this as a liquid ring in a WebGL shader; a 28px
 * mark in a topbar cannot justify a GL context, so it is rebuilt out of the
 * two things that actually carry the look — a conic sweep from violet through
 * cyan to ice, and an event horizon breathing in the middle. The ring is a
 * masked conic gradient rather than an SVG stroke because only a conic can
 * rotate the *colour* around the circle instead of rotating a shape.
 *
 * Both animations stop under `prefers-reduced-motion` (styles.css), which is
 * the same courtesy the site's shader extends by freezing its clock.
 */
function GateMark() {
  return (
    <span className="gate-mark" aria-hidden="true">
      <span className="gate-ring" />
      <span className="gate-core" />
    </span>
  );
}

/** The official GitHub mark — the one footer link that needs no label. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.15 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The version, and everything the update flow ever needs to say, in the one
 * element that was already showing the version.
 *
 * This is deliberately not a chip plus a button plus a settings page: the whole
 * conversation ("what am I running" → "is there more" → "get it" → "installing")
 * happens in place, in the slot you were already looking at. Hovering the version
 * turns it into **Check for updates**, checking turns it into a spinner, a result
 * turns it into the offer, and taking the offer turns it into a progress bar.
 * Nothing moves, nothing opens, and the topbar never grows a second control.
 */
function VersionBox({ version, u, onOpenUpdates }: { version: string; u: Updater; onOpenUpdates: () => void }) {
  const [hover, setHover] = useState(false);
  const { info, stage, progress } = u;
  if (!version) return null;

  const latest = info?.latest ?? progress?.version ?? '';
  const wrap = (children: ReactNode, extra = ''): ReactNode => (
    <span
      className={`verbox ${extra}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </span>
  );

  if (stage === 'checking') {
    return wrap(
      <span className="chip vb-busy" role="status" aria-live="polite">
        <Spinner /> Checking…
      </span>,
    );
  }

  if (stage === 'downloading') {
    const pct = progress?.fraction != null ? Math.round(progress.fraction * 100) : undefined;
    return wrap(
      <span className="chip vb-busy vb-progress" role="status" aria-live="polite">
        <Spinner /> Downloading v{latest}
        <ProgressBar fraction={progress?.fraction} />
        <b className="vb-pct">{pct != null ? `${pct}%` : fmtBytes(progress?.received ?? 0)}</b>
      </span>,
    );
  }

  if (stage === 'installing') {
    return wrap(
      <span className="chip vb-busy vb-progress" role="status" aria-live="polite">
        <Spinner /> Installing v{latest}
        <ProgressBar />
        <span className="vb-pct muted">restarting</span>
      </span>,
    );
  }

  if (stage === 'installed') {
    return wrap(
      <button className="chip chip-done" onClick={() => u.dismissResult()} title="Dismiss">
        ✓ Updated to v{version}
      </button>,
    );
  }

  if (stage === 'failed') {
    return wrap(
      <>
        <span className="chip chip-bad" title={u.error ?? 'The update failed'}>Update failed</span>
        <button className="btn sm vb-act" onClick={() => void u.install()}>Retry</button>
        <button className="btn sm btn-ghost vb-act" onClick={onOpenUpdates}>Details</button>
      </>,
    );
  }

  // The offer. A staged version has already been downloaded, so it asks for one
  // decision (install it) rather than the three an un-downloaded one does.
  if (stage === 'available' || stage === 'staged') {
    const ready = stage === 'staged';
    const chip = (
      <span
        className="chip chip-update"
        role="status"
        aria-label={`${ready ? 'Ready to install' : 'Update available'} v${latest}`}
        title={info?.releaseUrl ? `Release notes: ${info.releaseUrl}` : undefined}
      >
        <span className="vb-update-icon" aria-hidden="true">↑</span>
        <span className="vb-update-label">{ready ? 'Ready to install' : 'Update available'}</span>
        <b className="vb-update-version">v{latest}</b>
      </span>
    );
    // A channel we must not replace in place (an unsigned installer, a system
    // package, a checkout) gets pointed at the instructions instead of a button
    // that would refuse. Offering it here and refusing it in Settings would be
    // the same lie told twice.
    if (!info?.canApply) {
      return wrap(
        <>
          {chip}
          <button className="btn sm btn-accent vb-act" onClick={onOpenUpdates} title={info?.note ?? 'How to update this install'}>
            How to update
          </button>
          <button className="btn sm btn-ghost vb-act vb-tertiary" onClick={() => void u.skip()} title={`Stop offering v${latest}`}>
            Skip
          </button>
        </>,
        'verbox-offer',
      );
    }
    return wrap(
      <>
        {chip}
        {ready ? (
          <button className="btn sm btn-primary vb-act" onClick={() => void u.install()}>Install &amp; restart</button>
        ) : (
          <>
            <button className="btn sm btn-primary vb-act" onClick={() => void u.install()}>
              Download &amp; install
            </button>
            <button className="btn sm vb-act vb-secondary" onClick={() => void u.download()} disabled={!info.canDownload}
              title={info.canDownload
                ? `Fetch it now${info.downloadSize ? ` (${fmtBytes(info.downloadSize)})` : ''} and install it later`
                : 'This release has no downloadable package for this platform'}>
              Download only
            </button>
          </>
        )}
        <button className="btn sm btn-ghost vb-act vb-tertiary" onClick={() => void u.skip()} title={`Stop offering v${latest}`}>
          Skip
        </button>
      </>,
      'verbox-offer',
    );
  }

  // Nothing to offer: the version, which becomes the check when you reach for
  // it. "latest" stays visible after a check, because silence reads as
  // "hasn't looked" rather than "you're current".
  const checked = info?.latest && !info.updateAvailable;
  return wrap(
    <button
      className="chip vb-ver"
      onClick={() => void u.check(true)}
      title={info?.checkedAt ? `Last checked ${fmtRel(info.checkedAt)}. Click to check again` : 'Check for updates'}
    >
      {hover ? 'Check for updates' : <>v{version}{checked && <span className="vb-latest"> · latest</span>}</>}
    </button>,
    'verbox-idle',
  );
}

/** A small indeterminate spinner, for the states that are genuinely waiting. */
function Spinner() {
  return (
    <svg className="spin" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The bar. Determinate while bytes are arriving, indeterminate once the install
 * starts, because at that point the daemon reporting progress is the thing being
 * replaced — a percentage there would be invented.
 */
function ProgressBar({ fraction }: { fraction?: number }) {
  const known = fraction != null;
  return (
    <span
      className={`vb-bar${known ? '' : ' indet'}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(fraction * 100) : undefined}
    >
      <span className="vb-bar-fill" style={known ? { transform: `scaleX(${Math.max(0.03, fraction)})` } : undefined} />
    </span>
  );
}

/**
 * Whether the thing serving this page is well, and the way to turn it off.
 *
 * It says "server healthy" rather than "daemon up" because that is the question
 * being answered — is the gateway serving? — and because "daemon" is a word for
 * the implementation, not for what the user has running. Stop lives here, on
 * hover, for the same reason the update check lives next to the version: the
 * control belongs beside the state it changes. It stays hidden until you reach
 * for it (and is always visible on touch, where there is no hover), so the one
 * button that ends the session isn't sitting a stray click away.
 */
function ServerHealth({ offline, gateway }: { offline: boolean; gateway: GatewayInfo | null }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A daemon that went down has nothing left to confirm against.
  useEffect(() => { if (offline) { setConfirming(false); setErr(null); } }, [offline]);

  const stop = async () => {
    if (!gateway?.token) { setErr('No gateway token — reload the page.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await api.shutdown(gateway.token);
      setConfirming(false);
    } catch {
      setErr('The daemon refused the request.');
    }
    setBusy(false);
  };

  if (offline) {
    return (
      <span className="pill pill-errored"><span className="dot" />server offline</span>
    );
  }
  return (
    <span className="healthbox">
      <span className="pill pill-ready"><span className="dot" />server healthy</span>
      {confirming ? (
        <span className="hb-actions">
          <button className="btn sm btn-danger" onClick={() => void stop()} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop it'}
          </button>
          <button className="btn sm btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        </span>
      ) : (
        <button
          className="btn sm btn-ghost hb-stop"
          title="Stop the gateway and every managed server"
          onClick={() => setConfirming(true)}
        >
          Stop server
        </button>
      )}
      {err && <span className="small hb-err">{err}</span>}
    </span>
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
 * The gateway endpoint itself: URL + the master token. It sits beside the page
 * title so the server roster remains the first full-width working surface.
 */
function GatewayBar({ gateway }: { gateway: GatewayInfo }) {
  const [copied, copy] = useCopy();
  const [showToken, setShowToken] = useState(false);
  const token = gateway.token ?? '';
  return (
    <div className="gwbar" aria-label="Gateway credentials">
      <div className="gw-field">
        <span className="glabel"><span className="dot-grad" />Gateway</span>
        <span className="url" title={gateway.url}>{gateway.url}</span>
        <button className="btn sm" aria-label="Copy gateway URL" onClick={() => copy('url', gateway.url)}>{copied === 'url' ? 'Copied!' : 'Copy'}</button>
      </div>
      <div className="gw-field">
        <span className="glabel">Token</span>
        <span className="tok" title="Full-access master token">{showToken ? token.slice(0, 12) + '…' : '••••••'}</span>
        <button className="btn sm btn-ghost" aria-pressed={showToken} onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</button>
        <button className="btn sm" aria-label="Copy master token" onClick={() => copy('token', token)}>{copied === 'token' ? 'Copied!' : 'Copy'}</button>
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

/**
 * The two row actions that need no words: cycle it, or throw it away. Both are
 * universally read as icons, and dropping the labels keeps a long action row
 * from pushing the useful controls off the edge. They carry no box either: in
 * a row that already holds pills, chips and a switch, a bordered button is a
 * fourth kind of thing competing for the same glance, so the glyph is the
 * control and the semantic tint (amber = cycle, red = destroy) arrives on
 * hover. Every icon button keeps a title + aria-label so the intent survives
 * without the glyph.
 */
function Icon({ name }: { name: 'restart' | 'trash' }) {
  return (
    <svg
      viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
    >
      {name === 'restart' ? (
        <>
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </>
      ) : (
        <>
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M10 11v6M14 11v6" />
        </>
      )}
    </svg>
  );
}

function IconBtn({
  icon, label, tone, onClick, disabled,
}: {
  icon: 'restart' | 'trash'; label: string; tone: 'warn' | 'danger';
  onClick: () => void; disabled?: boolean;
}) {
  return (
    <button className={`btn sm btn-icon btn-${tone}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

/** The disclosure caret on an expandable row: a chevron that turns as it opens. */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={`row-caret ${open ? 'open' : ''}`} viewBox="0 0 24 24" width="13" height="13"
      aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

/**
 * A list row that opens.
 *
 * The row itself is the disclosure: everything about the thing lives inside it
 * rather than behind a button per topic (Logs, Agents, Tools: three buttons
 * that each answered "tell me more about this row"). The head stays the
 * summary you scan the list with, and one click anywhere on it swaps in the
 * whole story.
 *
 * The click target is the head, not a wrapping `<button>`: the head holds
 * switches, inputs and links, and interactive content inside a button is
 * neither valid nor navigable. The caret is the real control for the keyboard
 * and for assistive tech; clicking the head is the mouse's shortcut to it.
 */
function ExpandRow({
  open, onToggle, label, head, sub, actions, children,
}: {
  open: boolean;
  onToggle: () => void;
  /** What this row is, for the caret's accessible name. */
  label: string;
  /** The summary: pills, name, chips. */
  head: ReactNode;
  /** Anything that stays under the head in both states (a note, the last log line). */
  sub?: ReactNode;
  /** The controls, kept out of the click target. */
  actions: ReactNode;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <div className={`list-row expandable ${open ? 'open' : ''}`}>
      <div className="row-top" onClick={onToggle}>
        <div className="list-head between">
          <div className="row wrap-gap row-ident">
            <button
              className="caret-btn"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${open ? 'Hide' : 'Show'} details for ${label}`}
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
            >
              <Caret open={open} />
            </button>
            {head}
          </div>
          {/* Clicks on a control are about the thing, not about the row. */}
          <div className="row row-actions" onClick={(e) => e.stopPropagation()}>{actions}</div>
        </div>
        {sub}
      </div>
      {open && <RowDetail id={panelId}>{children}</RowDetail>}
    </div>
  );
}

/** The opened half of a row, brought into view when it lands below the fold. */
function RowDetail({ id, children }: { id: string; children: ReactNode }) {
  const reveal = useRevealOnMount<HTMLDivElement>();
  return <div className="row-detail" id={id} ref={reveal}>{children}</div>;
}

/** One labelled section inside an opened row. */
function Block({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section className="detail-block">
      <div className="detail-label">{label}</div>
      {children}
    </section>
  );
}

/**
 * A server's stderr, tailed while the row is open.
 *
 * Follows the newest line the way a terminal does, but only while you are
 * already at the bottom: scrolling up to read something is a decision, and a
 * pane that yanks you back two seconds later is unusable.
 */
function LogPane({ lines }: { lines: string[] | null }) {
  if (!lines) return <div className="small muted logs-note" role="status">Reading the log…</div>;
  return <LogConsole lines={lines} />;
}

function ServerRow({ s, agents, onChange }: { s: ServerStatus; agents: AgentClientInfo[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [armed, setArmed] = useState(false);
  const toast = useToast();
  const allowedBy = agents.filter((a) => a.servers === '*' || a.servers.includes(s.id)).length;
  const busy = s.state === 'starting';
  const running = s.state === 'ready' || s.state === 'starting';
  const isRemote = s.runtime === 'remote';
  const authorizing = s.state === 'authorizing';
  const act = async (action: 'start' | 'stop' | 'restart') => {
    try {
      await api.action(s.id, action);
      toast.show(`${action === 'stop' ? 'Stopped' : action === 'restart' ? 'Restarted' : 'Started'} ${s.name}`, 'success');
    } catch {
      toast.show(`Could not ${action} ${s.name}`, 'error');
    }
    onChange();
  };
  const signIn = async () => {
    const popup = reserveAuthWindow();
    const st = await api.authorize(s.id).catch(() => null);
    openAuth(st?.authUrl, popup);
    if (!st?.authUrl) toast.show(`Could not start sign-in for ${s.name}`, 'error');
    onChange();
  };

  // Open rows tail the log. The list poll carries the last line for the
  // collapsed rows, but a window onto the output is only worth opening if it
  // keeps up with what the server is saying.
  useEffect(() => {
    if (!open) { setLogs(null); return; }
    let live = true;
    const pull = () => api.logs(s.id).then((r) => { if (live) setLogs(r.logs); }).catch(() => {});
    void pull();
    const t = setInterval(pull, 3000);
    return () => { live = false; clearInterval(t); };
  }, [open, s.id]);

  return (
    <ExpandRow
      open={open}
      onToggle={() => setOpen((v) => !v)}
      label={s.name}
      head={
        <>
          <span className={`pill ${STATE_PILL[s.state] ?? 'pill-stopped'}`}><span className="dot" />{s.state}</span>
          <span className="server-name">{s.name}</span>
          <span className="chip">{RUNTIME_CHIP[s.runtime] ?? '⚡ process'}</span>
          {isRemote && s.url && <span className="chip mono" title={s.url}>{new URL(s.url).host}</span>}
          <AccountChip s={s} />
          {/* Counts are facts about the row, not buttons: the row itself is
              what opens, and it opens onto both of these in full. */}
          <span className="row-meta small muted">
            {s.state === 'ready' && <span>{s.tools.length} tool{s.tools.length === 1 ? '' : 's'}</span>}
            {agents.length > 0 && (
              <span
                style={allowedBy === 0 ? { color: 'var(--warning)' } : undefined}
                title="Connected agents allowed to use this server through the gateway"
              >
                {allowedBy === 0 ? 'no agents' : `${allowedBy}/${agents.length} agents`}
              </span>
            )}
          </span>
          {s.restarts > 0 && <span className="chip">{s.restarts} restarts</span>}
        </>
      }
      sub={
        <>
          {authorizing && (
            <p className="small muted row-note">
              Waiting for sign-in. Click <b>Sign in</b> to open {s.name}'s login in a new window — it connects automatically once you authorize.
            </p>
          )}
          {s.error && !authorizing && <p className="small row-note" style={{ color: 'var(--danger)' }}>{s.error}</p>}
          {/* What the server said last, where the Logs button used to be. An
              errored row already carries the sentence that matters; the log
              line under it would be the same news in a duller voice. */}
          {!open && !s.error && s.lastLog && <div className="row-lastlog mono" title={s.lastLog}>{s.lastLog}</div>}
        </>
      }
      actions={
        <>
          {authorizing ? (
            <button className="btn sm btn-primary" onClick={() => void signIn()}>🔐 Sign in</button>
          ) : (
            /* Up/down is one bit of state, so it gets one control. It reads as on
               while starting — that is where the click is taking it — and stays
               disabled until the daemon settles, which the state pill narrates. */
            <button
              role="switch"
              aria-checked={running}
              aria-label={running ? `Stop ${s.name}` : `Start ${s.name}`}
              title={running ? `Stop ${s.name}` : `Start ${s.name}`}
              className={`toggle sm toggle-go ${running ? 'on' : ''}`}
              disabled={busy}
              onClick={() => void act(running ? 'stop' : 'start')}
            >
              <span className="knob" />
            </button>
          )}
          {!authorizing && (
            <IconBtn icon="restart" label={`Restart ${s.name}`} tone="warn" onClick={() => void act('restart')} disabled={busy} />
          )}
          {/* Remove takes the sign-in with it, so the trash asks once. Two
              clicks in the same spot, not a modal — the cost of a misclick is
              a re-authorization, not a lost afternoon. */}
          {armed ? (
            <>
              <button
                className="btn sm btn-danger"
                onClick={() => {
                  void api.remove(s.id).then(
                    () => { toast.show(`Removed ${s.name}`, 'success'); onChange(); },
                    () => toast.show(`Could not remove ${s.name}`, 'error'),
                  );
                }}
                title={`Remove ${s.name}${isRemote ? ' and delete its stored sign-in' : ''}`}
              >
                {isRemote ? 'Remove & sign out' : 'Remove'}
              </button>
              <button className="btn sm" onClick={() => setArmed(false)}>Cancel</button>
            </>
          ) : (
            <IconBtn icon="trash" label={`Remove ${s.name}`} tone="danger" onClick={() => setArmed(true)} />
          )}
        </>
      }
    >
      {s.tools.length > 0 && (
        <Block label={<>Tools <span className="dl-count">{s.tools.length}</span></>}>
          <ToolList serverId={s.id} tools={s.toolDetails ?? s.tools.map((name) => ({ name }))} />
        </Block>
      )}
      {agents.length > 0 && (
        <Block label={<>Agents <span className="dl-count">{allowedBy}/{agents.length}</span></>}>
          <ServerAgents server={s} agents={agents} onChange={onChange} />
        </Block>
      )}
      <Block label={<>Logs {isRemote && <span className="dl-note">a remote server runs on its provider's machine, so it has no local output</span>}</>}>
        <LogPane lines={logs} />
      </Block>
    </ExpandRow>
  );
}

/**
 * Which account a signed-in server is signed in as.
 *
 * "Connected" is only half of what you want to know about a remote server —
 * the other half is *whose* account the agent is acting through, since that is
 * what decides which repos, issues or projects it can see. Shown right on the
 * row, next to the state, because that is where you look when something comes
 * back empty and you start to wonder which account you signed in with.
 *
 * When the provider hands out an opaque token and offers no identity endpoint,
 * this says "signed in" and stops there. That is the honest answer; inventing a
 * name from the server's own title would be worse than admitting we don't know.
 */
function AccountChip({ s }: { s: ServerStatus }) {
  if (!s.signedIn) return null;
  const a = s.account;
  if (!a) {
    return <span className="chip chip-account" title="Signed in — this provider doesn't say which account">👤 signed in</span>;
  }
  // A raw subject id is a UUID as often as not; keep the row readable and put
  // the whole thing in the tooltip.
  const opaque = !a.email && !a.name && a.label.length > 14 && !a.label.includes('@') && !a.label.includes(' ');
  const shown = opaque ? `${a.label.slice(0, 10)}…` : a.label;
  const detail = [a.email, a.name, a.org && `org: ${a.org}`, a.subject && `id: ${a.subject}`]
    .filter(Boolean)
    .join(' · ');
  // `source` is required by the type, but it arrives as parsed JSON from a
  // keychain entry an older build may have written — and a missing field here
  // used to take down the entire page, not just this chip.
  const from = a.source ? ` (from the ${a.source.replace('_', ' ')})` : '';
  return (
    <span className="chip chip-account" title={`Signed in as ${a.label}${detail ? ` — ${detail}` : ''}${from}`}>
      👤 {shown}
      {a.org && <span className="muted"> · {a.org}</span>}
    </span>
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
              <AgentMark id={a.target} name={a.name} small />
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

/** What actually installs the login item, per platform — stated, not implied. */
const STARTUP_MECHANISM: Record<string, string> = {
  win32: 'A per-user startup entry',
  darwin: 'A per-user LaunchAgent',
  linux: 'An XDG autostart entry',
};

/**
 * What the window's close button does — the same choice the app asks for the
 * first time you close it, kept here so it can be changed without hunting.
 *
 * It is three options rather than a switch because "ask me" is a real state, and
 * hiding it would mean the first-run prompt has no home in Settings afterwards.
 */
function CloseActionRow({ value, busy, onChange }: { value: CloseAction; busy: boolean; onChange: (v: CloseAction) => void }) {
  const opts: [CloseAction, string][] = [
    ['tray', 'Minimize to tray'],
    ['quit', 'Quit & stop the server'],
    ['ask', 'Ask each time'],
  ];
  return (
    <div className="list-row setting-row">
      <div className="setting-text">
        <div className="setting-label">Closing the window</div>
        <div className="small muted">
          {value === 'quit'
            ? 'The close button shuts down the gateway and every managed server.'
            : value === 'tray'
              ? 'The close button hides the window; the gateway and your servers keep running.'
              : "Hypergate will ask the first time you close the window, and remember your answer."}
        </div>
      </div>
      <div className="seg" style={{ flex: 'none' }}>
        {opts.map(([v, label]) => (
          <button key={v} className={value === v ? 'active' : ''} disabled={busy} onClick={() => onChange(v)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

/** Updates, service/desktop options (run at login, start minimized), stop the daemon. */
function SettingsView({ gateway, version, u }: { gateway: GatewayInfo | null; version: string; u: Updater }) {
  const checking = u.stage === 'checking';
  const onCheck = (): void => void u.check(true);
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

      <div className="section-title" id="updates">
        Updates
        <span className="rt">
          <button className="btn sm" onClick={onCheck} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </span>
      </div>
      <div className="panel"><div className="list">
        <UpdateRow u={u} version={version} />
      </div></div>

      <div className="section-title">Startup &amp; desktop</div>
      <div className="panel">
        {!s ? (
          <div className="list-row small muted">Loading…</div>
        ) : (
          <div className="list">
            <ToggleRow
              label="Run on startup"
              desc={
                !s.startupSupported
                  ? `Hypergate can't work out what to launch at login on this install, so it won't pretend to. Put \`hypergated\` on your PATH, or install the desktop shell.`
                  : s.startupVia === 'shell'
                    ? `${STARTUP_MECHANISM[s.platform] ?? 'A login item'} launches Hypergate in the tray when you sign in.`
                    : `${STARTUP_MECHANISM[s.platform] ?? 'A login item'} starts the gateway when you sign in. Install the desktop shell to get the tray icon with it.`
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
            <CloseActionRow
              value={s.closeAction}
              busy={busy === 'closeAction'}
              onChange={(v) => void update({ closeAction: v }, 'closeAction')}
            />
          </div>
        )}
      </div>
      {err && <p className="small" style={{ color: 'var(--danger)', marginTop: 10 }}>{err}</p>}
      <p className="small muted" style={{ marginTop: 12 }}>
        {s?.startupCommand ? (
          <>Login runs <code>{s.startupCommand}</code>. </>
        ) : null}
        The tray keeps the daemon running in the background — right-click its icon for Open manager / Restart / Quit,
        and double-click it to open the app.
      </p>

      <div className="section-title">
        This daemon
        {version && <span className="rt"><span className="chip">v{version}</span></span>}
      </div>
      <div className="panel"><div className="list">
        <StopDaemon gateway={gateway} />
      </div></div>
    </>
  );
}

const CHANNEL_LABEL: Record<InstallChannel, string> = {
  npm: 'installed with npm',
  installer: 'installed from the native installer',
  repo: 'running from a checkout',
  unknown: 'installed some other way',
};

/**
 * The Updates row: what you're running, what's out there, and the one button
 * that closes the gap when we can do it for you.
 *
 * One-click is limited to an npm install by design (see `updatePlan` in core):
 * the native installers aren't signed yet, and downloading and running an
 * unsigned installer unattended would be worse than pointing you at the release.
 * Every channel still shows the exact command, so nothing is hidden.
 */
function UpdateRow({ u, version }: { u: Updater; version: string }) {
  const [copied, copy] = useCopy();
  const { info, stage, progress } = u;

  if (!info) {
    return <div className="list-row small muted">Checking for updates…</div>;
  }

  const busy = stage === 'downloading' || stage === 'installing';
  const skipped = info.skipped && info.skipped === info.latest;

  const headline = busy
    ? `${stage === 'downloading' ? 'Downloading' : 'Installing'} Hypergate ${progress?.version ?? info.latest}`
    : stage === 'installed'
      ? `Updated to Hypergate ${version}`
      : stage === 'staged'
        ? `Hypergate ${info.latest} is downloaded and ready to install`
        : info.updateAvailable
          ? `Hypergate ${info.latest} is available`
          : info.latest
            ? "You're on the latest version"
            : 'Update check';

  return (
    <div className="list-row setting-row">
      <div className="setting-text">
        <div className="setting-label">{headline}</div>
        <div className="small muted">
          Running <b>v{info.current || version}</b>
          {info.latest && !info.updateAvailable && <> · latest is <b>v{info.latest}</b></>}
          {' · '}
          {CHANNEL_LABEL[info.channel]}
          {info.downloadSize && info.updateAvailable && <> · {fmtBytes(info.downloadSize)} download</>}
          {info.checkedAt && <> · checked {fmtRel(info.checkedAt)}</>}
        </div>
        {!info.latest && (
          <div className="small muted" style={{ marginTop: 4 }}>
            {info.error
              ? `Couldn't reach the update feed (${info.error}). Hypergate never checks on its own, so this is only ever a connection problem, not telemetry.`
              : 'No published release found yet, so there is nothing to compare against. Hypergate only looks when you open this page or press the button, never on its own.'}
          </div>
        )}
        {info.updateAvailable && info.note && <div className="small muted" style={{ marginTop: 4 }}>{info.note}</div>}
        {busy && (
          <div style={{ marginTop: 8, maxWidth: 340 }}>
            <ProgressBar fraction={stage === 'downloading' ? progress?.fraction : undefined} />
            <div className="small muted" style={{ marginTop: 5 }}>
              {stage === 'downloading' ? (
                <>
                  {progress?.file ?? 'package'} · {fmtBytes(progress?.received ?? 0)}
                  {progress?.total ? ` of ${fmtBytes(progress.total)}` : ''}
                </>
              ) : (
                <>
                  Hypergate is stopping, installing, and starting again on its own. This page reconnects when it's back;
                  every step is logged to <code>~/.hypergate/update.log</code>.
                </>
              )}
            </div>
          </div>
        )}
        {skipped && !busy && (
          <div className="small muted" style={{ marginTop: 6 }}>
            You skipped this version. It stays here, and checking again brings it back to the topbar.
          </div>
        )}
        {u.error && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{u.error}</div>}
        {info.updateAvailable && info.command && !busy && (
          <div className="row wrap-gap" style={{ marginTop: 8 }}>
            <code className="path">{info.command}</code>
            <button className="btn sm" onClick={() => copy('cmd', info.command ?? '')}>{copied === 'cmd' ? 'Copied!' : 'Copy'}</button>
          </div>
        )}
      </div>
      <div className="row" style={{ flex: 'none' }}>
        {info.releaseUrl && info.updateAvailable && (
          <a className="btn sm" href={info.releaseUrl} target="_blank" rel="noreferrer">Release notes</a>
        )}
        {info.updateAvailable && info.canApply && !busy && (
          <>
            {stage !== 'staged' && info.canDownload && (
              <button className="btn sm" onClick={() => void u.download()}>Download only</button>
            )}
            {skipped ? (
              <button className="btn sm" onClick={() => void u.unskip()}>Un-skip</button>
            ) : (
              <button className="btn sm btn-ghost" onClick={() => void u.skip()}>Skip</button>
            )}
            <button className="btn btn-primary" onClick={() => void u.install()}>
              {stage === 'staged' ? 'Install & restart' : 'Download & install'}
            </button>
          </>
        )}
      </div>
    </div>
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

      {/* The pitch belongs to the empty state: once the numbers are there they
          make the case themselves, and the height is worth more to the lists. */}
      {!hasData && (
        <div className="callout">
          <span className="ic">🔎</span>
          <div>
            <div className="t">Why route through Hypergate? You get an audit trail for free.</div>
            <div className="d">Point agents at one gateway and Hypergate records every call — per server, per client, per byte — so you can see exactly what your tools are doing. No dashboards to wire up, no data leaving localhost.</div>
          </div>
        </div>
      )}

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

          {/* Two peer breakdowns, side by side while the window is wide enough:
              the dashboard spends the width it has so the height stays for the
              lists. Below ~860px they stack again (see `.duo`). */}
          <div className="duo">
            <section>
              <div className="section-title">Usage by server</div>
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
            </section>

            <section>
              <div className="section-title">Who's calling</div>
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
            </section>
          </div>

          <div className="section-title">Recent calls</div>
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
      ) : stats === null ? (
        <EmptyState glyph="📡" title="Loading analytics…" loading>
          Reading the gateway's local call log. This stays on your machine.
        </EmptyState>
      ) : (
        <EmptyState glyph="📡" title="No calls yet.">
          Connect an agent to the gateway and start a server. Every tool call it makes will appear here — with the caller, latency, and data volume.
        </EmptyState>
      )}
    </>
  );
}

function AddServer({ entry, onClose, onAdded }: { entry: RegistryEntry | null; onClose: () => void; onAdded: () => void }) {
  const reveal = useRevealOnMount<HTMLElement>();
  const [runtime, setRuntime] = useState<RuntimeKind>(entry?.runtime ?? 'process');
  const [name, setName] = useState(entry?.name ?? '');
  const [command, setCommand] = useState(entry?.command ?? '');
  const [args, setArgs] = useState((entry?.args ?? []).join(' '));
  const [image, setImage] = useState(entry?.image ?? '');
  const [env, setEnv] = useState((entry?.requires ?? []).map((k) => `${k}=`).join('\n'));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

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
      toast.show(`Added ${cfg.name} — starting…`, 'success');
      onAdded();
    } catch (e) {
      setErr(e instanceof Error && e.message === '409' ? 'A server with that id already exists.' : 'Could not add the server, check the daemon logs.');
      toast.show(`Could not add ${cfg.name}`, 'error');
    }
    setBusy(false);
  };

  return (
    <section className="panel panel-scroll" style={{ marginTop: 14, padding: 18 }} ref={reveal}>
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
          <button className={`btn btn-catalog-add ${oauth ? 'btn-primary' : ''}`} onClick={() => onPick(e)} disabled={!runnable} title={runnable ? '' : e.note ?? 'Not locally runnable'}>
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
  const reveal = useRevealOnMount<HTMLDivElement>();

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
  const visibleResults = useMemo(
    () => (results ? mergeCatalogSearch(sortedCurated, results, q) : null),
    [q, results, sortedCurated],
  );
  return (
    <>
      <div className="section-title">Add a server</div>
      <div className="panel" ref={reveal}>
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
            visibleResults && visibleResults.length > 0 ? (
              visibleResults.map((e) => <CatalogRow key={e.id} e={e} onPick={onPick} />)
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
 * How a client gets wired up, in three words for a picker card. `cli` isn't
 * here because a CLI's card says something more useful — whether we can see it
 * on this machine.
 */
const METHOD_LABEL: Record<string, string> = {
  config: 'Config file',
  manual: 'In-app setup',
};

const AGENT_BRAND_PATH: Record<string, string> = {
    'claude-code': 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
    cursor: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
    'gemini-cli': 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
  vscode: 'M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z',
};

function AgentMark({ id, name, small = false }: { id?: string; name?: string; small?: boolean }) {
  const resolved = id ?? ({ 'Claude Code': 'claude-code', Cursor: 'cursor', Kotrain: 'kotrain', OpenClaw: 'openclaw', 'Gemini CLI': 'gemini-cli', Hermes: 'hermes', 'VS Code': 'vscode', '.mcp.json': 'mcp-json', Odysseus: 'odysseus', Devin: 'devin' }[name ?? '']);
  const className = `ag-mark ag-mark-${resolved ?? 'custom'} ${small ? 'small' : ''}`;
  const path = resolved ? AGENT_BRAND_PATH[resolved] : undefined;
  if (path) return <span className={className} aria-hidden="true"><svg viewBox="0 0 24 24"><path d={path} /></svg></span>;
  if (resolved === 'openclaw') return <span className={className} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 17c1-5 3-8 7-10m0 10c0-5 1-9 4-12m1 12c1-4 2-6 4-8M4 18c4 2 10 2 16 0" /></svg></span>;
  if (resolved === 'hermes') return <span className={className} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7c4 0 6 2 7 5 1-3 3-5 7-5-1 4-3 6-7 6-4 0-6-2-7-6Zm7 6v7m-3-3h6" /></svg></span>;
  if (resolved === 'mcp-json') return <span className={className} aria-hidden="true"><span className="ag-glyph">{'{ }'}</span></span>;
  if (resolved === 'kotrain') return <span className={className} aria-hidden="true"><span className="ag-glyph">K</span></span>;
  if (resolved === 'odysseus') return <span className={className} aria-hidden="true"><span className="ag-glyph">O</span></span>;
  if (resolved === 'devin') return <span className={className} aria-hidden="true"><span className="ag-glyph">D</span></span>;
  return <span className={className} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span>;
}

/**
 * The agent catalog: which harness are you connecting?
 *
 * "+ Add agent" asks this first, because it is the question that decides
 * everything after it — the name, and the one way that client gets connected.
 * The old flow asked for a name instead and then showed every client we know as
 * a row of tabs under the agent, which put the choice in the wrong place: an
 * agent called "Cursor" has no use for Claude Code's install command.
 */
function AgentPicker({
  targets, agents, busy, error, onPick, onCustom, onClose,
}: {
  targets: ConnectTargetStatus[];
  agents: AgentClientInfo[];
  busy: string | null;
  error: string | null;
  onPick: (t: ConnectTargetStatus) => void;
  onCustom: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="agent-picker">
      <div className="row between">
        <div>
          <b>Which agent are you connecting?</b>
          <div className="small muted" style={{ marginTop: 3 }}>
            It gets its own token — scoped to every server to start with, and revocable on its own.
          </div>
        </div>
        {onClose && <button className="btn sm btn-ghost" onClick={onClose}>✕</button>}
      </div>
      <div className="ag-grid">
        {targets.map((t) => {
          const added = agents.some((a) => a.target === t.id || (!a.target && a.name === t.name));
          const detected = t.method === 'cli' && t.found;
          const loading = busy === t.id;
          const state = loading
            ? 'Connecting…'
            : added
              ? 'Connected'
              : detected
                ? `Ready${t.version ? ` · v${t.version}` : ''}`
                : t.method === 'cli'
                  ? 'CLI not found'
                  : METHOD_LABEL[t.method];
          const tone = loading ? 'loading' : added ? 'connected' : detected ? 'ready' : t.method;
          return (
            <button
              key={t.id}
              className={`ag-card ${detected ? 'ag-found' : ''} ${added ? 'ag-added' : ''}`}
              disabled={loading}
              title={added ? `${t.name} is already connected — opens its instructions again` : t.hint}
              onClick={() => onPick(t)}
            >
              <AgentMark id={t.id} />
              <span className="ag-copy">
                <span className="ag-line">
                  <span className="ag-name">{t.name}</span>
                  <span className={`ag-state ${tone}`}><span className="ag-state-dot" />{state}</span>
                </span>
                <span className="ag-blurb small muted">{t.blurb ?? t.hint}</span>
              </span>
              <span className="ag-go" aria-hidden="true">›</span>
            </button>
          );
        })}
        <button className="ag-card ag-custom" onClick={onCustom}>
          <AgentMark />
          <span className="ag-copy">
            <span className="ag-line">
              <span className="ag-name">Custom agent</span>
              <span className="ag-state manual"><span className="ag-state-dot" />Custom setup</span>
            </span>
            <span className="ag-blurb small muted">Anything else that speaks MCP. You name it, and pick what it may reach.</span>
          </span>
          <span className="ag-go" aria-hidden="true">›</span>
        </button>
      </div>
      {error && <div className="small" style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</div>}
    </div>
  );
}

/**
 * "Connected agents" — the one place an agent gets connected. Each row is a
 * scoped gateway token with its per-server permissions, and its own Connect
 * panel showing that client's own way in: one click to have Hypergate run its
 * `mcp add`, the exact command if you'd rather run it yourself, the snippet for
 * its config file, or the endpoint to paste into its settings.
 */
function ConnectedAgents({ agents, servers, onChange }: { agents: AgentClientInfo[]; servers: ServerStatus[]; onChange: () => void }) {
  /** The catalog is open (from "+ Add agent"), or the custom-agent form is. */
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState<AgentClientInfo | 'new' | null>(null);
  /** Agent whose Connect panel is open, which client it opened on, and whether to install straight away. */
  const [connect, setConnect] = useState<{ id: string; target?: string; run?: boolean } | null>(null);
  const [targets, setTargets] = useState<ConnectTargetsInfo | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void api.connectTargets().then(setTargets).catch(() => {}); }, []);

  // Pick a known agent: create its scoped token and go straight to how it gets
  // connected. Re-picking one you already have reopens it rather than stacking
  // a duplicate — the catalog is a way in, not an "add another".
  const addKnown = useCallback(async (t: ConnectTargetStatus) => {
    setAdding(t.id);
    setErr(null);
    const existing = agents.find((a) => a.target === t.id) ?? agents.find((a) => !a.target && a.name === t.name);
    const agent = existing ?? (await api.addClient({ name: t.name, servers: '*', target: t.id }).catch(() => null));
    setAdding(null);
    if (!agent) {
      setErr(`Could not create the ${t.name} agent — check the daemon logs.`);
      return;
    }
    setPicking(false);
    onChange();
    // A detected CLI is genuinely one click: create, install, show the outcome.
    setConnect({ id: agent.id, target: t.id, run: !existing && t.method === 'cli' && t.found });
  }, [agents, onChange]);

  const picker = (onClose?: () => void) => (
    <AgentPicker
      targets={targets?.targets ?? []}
      agents={agents}
      busy={adding}
      error={err}
      onPick={(t) => void addKnown(t)}
      onCustom={() => { setPicking(false); setCustom('new'); }}
      onClose={onClose}
    />
  );

  return (
    <>
      <div className="section-title">
        Connected agents
        <span className="rt">
          <button
            className={`btn sm ${picking ? '' : 'btn-accent'}`}
            onClick={() => { setPicking((v) => !v); setCustom(null); setErr(null); }}
          >
            {picking ? 'Close' : '+ Add agent'}
          </button>
        </span>
      </div>
      {agents.length === 0 && !picking && !custom ? (
        <div className="panel"><div className="empty empty-pick">
          <div className="cat">🔌</div>
          <b>No agents connected yet.</b>
          {picker()}
        </div></div>
      ) : (
        <>
          {agents.length > 0 && (
            <div className="panel"><div className="list">
              {agents.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  servers={servers}
                  connect={connect?.id === a.id ? connect : null}
                  onConnect={() => setConnect(connect?.id === a.id ? null : { id: a.id })}
                  onChange={onChange}
                />
              ))}
              {picking && <PickerRow>{picker()}</PickerRow>}
            </div></div>
          )}
        </>
      )}
      {custom && (
        <AgentEditor
          agent={custom === 'new' ? null : custom}
          servers={servers}
          onClose={() => setCustom(null)}
          onSaved={(saved, created) => {
            setCustom(null);
            onChange();
            // A brand-new agent isn't connected to anything yet — go straight to how.
            if (created) setConnect({ id: saved.id });
          }}
        />
      )}
    </>
  );
}

/** The agent picker's roster row, which scrolls itself into view when it opens. */
function PickerRow({ children }: { children: ReactNode }) {
  const reveal = useRevealOnMount<HTMLDivElement>();
  return (
    <div className="list-row agent-picker-row" ref={reveal}>
      {children}
    </div>
  );
}

/**
 * A custom agent's name, edited where it is shown.
 *
 * There is no Edit button any more: for an agent you named, the name *is* the
 * control — click it and type. For one picked from the catalog there is nothing
 * to edit (it is Cursor, and calling it something else would only make the row
 * lie about whose token it is), so that name renders as text and the daemon
 * refuses the rename too.
 */
function AgentName({ agent, onChange }: { agent: AgentClientInfo; onChange: () => void }) {
  const [value, setValue] = useState(agent.name);
  const [failed, setFailed] = useState(false);
  // The list is re-polled every couple of seconds; follow a name that changed
  // underneath us rather than pinning the stale one in the box.
  useEffect(() => setValue(agent.name), [agent.name]);

  const commit = async () => {
    const next = value.trim();
    if (!next || next === agent.name) { setValue(agent.name); setFailed(false); return; }
    try {
      await api.updateClient(agent.id, { name: next });
      setFailed(false);
      onChange();
    } catch {
      setFailed(true);
      setValue(agent.name);
    }
  };

  return (
    <input
      className={`agent-name-input ${failed ? 'bad' : ''}`}
      value={value}
      aria-label="Agent name"
      title={failed ? 'That rename did not save — check the daemon logs' : 'Click to rename'}
      size={Math.max(6, value.length)}
      // The row opens when you click it; clicking into the name is asking to
      // type, not to open the row.
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setValue(agent.name); e.currentTarget.blur(); }
      }}
    />
  );
}

function AgentRow({
  agent, servers, connect, onConnect, onChange,
}: {
  agent: AgentClientInfo;
  servers: ServerStatus[];
  connect: { id: string; target?: string; run?: boolean } | null;
  onConnect: () => void;
  onChange: () => void;
}) {
  const [copied, copy] = useCopy();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Opened by hand. A quick-connect from the picker opens it from outside. */
  const [opened, setOpened] = useState(false);
  const open = opened || !!connect;
  const all = agent.servers === '*';
  const ids = agent.servers === '*' ? [] : agent.servers;
  /** Ids the agent still lists but that no longer exist, shown so they can be cleared. */
  const orphaned = ids.filter((id) => !servers.some((s) => s.id === id));
  const allowed = all ? servers.length : servers.filter((s) => ids.includes(s.id)).length;
  const [permErr, setPermErr] = useState<string | null>(null);
  const flip = async (serverId: string, allowedNow: boolean) => {
    setBusy(serverId);
    setPermErr(null);
    try {
      await api.setAgentServer(agent.id, serverId, allowedNow);
    } catch {
      setPermErr('Could not change that permission. Check the daemon logs.');
    }
    setBusy(null);
    onChange();
  };
  const toggle = () => {
    // A row the picker opened is closed by clearing that, or it would spring
    // straight back open on the next render.
    if (connect) { onConnect(); setOpened(false); return; }
    setOpened((v) => !v);
  };
  return (
    <ExpandRow
      open={open}
      onToggle={toggle}
      label={agent.name}
      head={
        <>
          <AgentMark id={agent.target} name={agent.name} small />
          {agent.target ? (
            <>
              <span className="server-name">{agent.name}</span>
              <span className="chip" title="Added from the agent catalog, so it carries that product's name">official</span>
            </>
          ) : (
            <AgentName agent={agent} onChange={onChange} />
          )}
          {/* What it may reach, as a fact. The chips that change it are inside. */}
          {all ? (
            <span className="chip chip-accent" title="Including any server added later">all servers</span>
          ) : servers.length === 0 ? (
            <span className="small muted">no servers configured yet</span>
          ) : allowed === 0 ? (
            <span className="chip" style={{ color: 'var(--danger)' }}>blocked, no servers</span>
          ) : (
            <span className="small muted">can use {allowed}/{servers.length} servers</span>
          )}
        </>
      }
      actions={
        <>
          <span className="small muted">{agent.lastUsed ? `used ${fmtRel(agent.lastUsed)}` : 'never used'}</span>
          <IconBtn icon="trash" label={`Remove ${agent.name}`} tone="danger" onClick={() => { void api.removeClient(agent.id).then(onChange); }} />
        </>
      }
    >
      <Block label="Token">
        <div className="row wrap-gap">
          <span className="tok mono">{show ? agent.token : '••••••••••••••••'}</span>
          <button className="btn sm btn-ghost" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
          <button className="btn sm" onClick={() => copy(`tok-${agent.id}`, agent.token)}>{copied === `tok-${agent.id}` ? 'Copied!' : 'Copy token'}</button>
        </div>
      </Block>

      {/* Permissions are editable right here: one click per server, no dialog.
          The chips are the state and the control at once, so "what may this
          agent reach" and "change it" are the same place. */}
      <Block label="Can use">
        <div className="perm-row">
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
      </Block>

      <AgentConnect agent={agent} initialTarget={connect?.target} autoRun={connect?.run} />
    </ExpandRow>
  );
}

const SHELL_LABEL: Record<ConnectShell, string> = { powershell: 'PowerShell', cmd: 'cmd.exe', bash: 'bash / zsh' };

/**
 * The connect panel for one agent: how *this* client gets connected.
 *
 * An agent added from the catalog knows what it is, so this shows one client's
 * instructions and nothing else. (It used to show a tab per client under every
 * agent, which offered Cursor's config file under an agent called "Claude Code"
 * — six wrong answers surrounding the right one.) A custom agent is the only
 * case where we genuinely don't know, so that one gets a client chooser.
 *
 * Whatever the route, the exact command or snippet is on screen — quoted for the
 * shell you're actually in — so the button is a shortcut, not a black box.
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
        // An official agent has exactly one answer; a custom one starts on the
        // client this machine actually has.
        setTab((t) => t ?? i.target ?? i.targets.find((x) => x.method === 'cli' && x.found)?.id ?? i.targets[0]?.id);
        if (autoRun && initialTarget && !ran.current) {
          ran.current = true;
          void run(initialTarget);
        }
      })
      .catch(() => setFailed(true));
  }, [agent.id, autoRun, initialTarget, run]);

  if (failed) return <div className="connect-panel small" style={{ color: 'var(--danger)' }}>Could not load connect options — is the daemon still running?</div>;
  if (!info || !shell) return <div className="connect-panel small muted">Loading connect options…</div>;

  const t = info.targets.find((x) => x.id === (info.target ?? tab));
  return (
    <div className="connect-panel">
      <div className="conn-head">
        {info.target ? (
          <span className="conn-title">Connect {t?.name ?? info.target}</span>
        ) : (
          <label className="conn-pick small muted">
            This agent's client
            <select
              className="client-select"
              value={tab ?? ''}
              onChange={(e) => { setTab(e.target.value); setResult(null); }}
            >
              {info.targets.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.method === 'cli' && x.found ? ' · detected' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {t?.homepage && (
          <a className="small muted conn-docs" href={t.homepage} target="_blank" rel="noreferrer">docs ↗</a>
        )}
      </div>

      {t && (
        <div className="conn-body">
          {t.hint && <div className="small muted">{t.hint}</div>}
          {t.note && <div className="small" style={{ color: 'var(--warning)', marginTop: 6 }}>{t.note}</div>}

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
              {/* No CLI on this machine is not a dead end when we know the file. */}
              {!t.found && t.snippet && (
                <>
                  <div className="row wrap-gap" style={{ marginTop: 10 }}>
                    <span className="small muted">or write it yourself into</span>
                    <code className="path">{t.configPath ?? `${t.name}'s MCP config`}</code>
                    <div className="spacer" style={{ flex: 1 }} />
                    <button className="btn sm" onClick={() => copy('snip', t.snippet ?? '')}>{copied === 'snip' ? 'Copied!' : 'Copy snippet'}</button>
                  </div>
                  <pre className="snippet">{t.snippet}</pre>
                </>
              )}
            </>
          ) : t.method === 'manual' ? (
            /* No file to write and no CLI to run: this client keeps its MCP list
               in its own UI, so hand over exactly the two values it will ask for. */
            <>
              <div className="conn-fields">
                <div className="conn-field">
                  <span className="small muted">Server URL</span>
                  <code className="path">{info.url}</code>
                  <button className="btn sm" onClick={() => copy('url', info.url)}>{copied === 'url' ? 'Copied!' : 'Copy'}</button>
                </div>
                <div className="conn-field">
                  <span className="small muted">Header</span>
                  <code className="path">Authorization: Bearer {(t.token ?? '').slice(0, 8)}…</code>
                  <button className="btn sm" onClick={() => copy('hdr', `Authorization: Bearer ${t.token ?? ''}`)}>
                    {copied === 'hdr' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div className="conn-field">
                  <span className="small muted">Token only</span>
                  <code className="path">{(t.token ?? '').slice(0, 8)}••••••</code>
                  <button className="btn sm" onClick={() => copy('tok', t.token ?? '')}>{copied === 'tok' ? 'Copied!' : 'Copy'}</button>
                </div>
              </div>
              <div className="small muted" style={{ marginTop: 8 }}>
                Transport is streamable HTTP. Name the entry <code>{info.entryName}</code> so a later re-connect replaces it.
              </div>
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
  const reveal = useRevealOnMount<HTMLElement>();
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
        : await api.addClient({ name: name.trim(), servers: scoped });
      onSaved(saved, !agent);
    } catch {
      setErr('Could not save the agent, check the daemon logs.');
    }
    setBusy(false);
  };

  return (
    <section className="panel panel-scroll" style={{ marginTop: 14, padding: 18 }} ref={reveal}>
      <div className="row between">
        <b>{agent ? `Edit ${agent.name}` : 'Add a custom agent'}</b>
        <button className="btn sm btn-ghost" onClick={onClose}>✕</button>
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        For a client that isn't in the catalog. You name it, and you can rename it later from its row.
      </p>
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
 *
 * This lists what you *have*. It used to list all 22 tools we know of and mark
 * the absent ones "missing", which read as a fault report — as though the app
 * wanted them and something had gone wrong — when the honest meaning was only
 * "we have heard of this and you have not installed it". Nobody needs a
 * standing list of software they don't own. The ones you don't have are a
 * suggestion, so they live behind "Install a tool", where they are an offer
 * rather than a complaint.
 */
function CliSection() {
  const [clis, setClis] = useState<CliStatus[] | null>(null);
  const [open, setOpen] = useState(true);
  const [offering, setOffering] = useState(false);
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

  const installed = (clis ?? []).filter((c) => c.found);
  const available = (clis ?? []).filter((c) => !c.found);
  const query = q.trim().toLowerCase();
  const matches = (c: CliStatus): boolean =>
    !query || c.name.toLowerCase().includes(query) || c.command.toLowerCase().includes(query) || c.description.toLowerCase().includes(query);
  const filtered = installed.filter(matches);
  // The ad-hoc probe answers for anything on PATH, so it only earns a row when
  // the list above can't already answer: an exact command we detected is that
  // row, not a second one saying the same thing.
  const knownExact = installed.some((c) => c.command.toLowerCase() === query);
  const showAdhoc = query.length > 0 && !knownExact;

  return (
    <>
      <div className="section-title">
        Command-line tools
        <span className="rt">
          {clis && <span className="small muted" style={{ marginRight: 8 }}>{installed.length} detected</span>}
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
                {filtered.length === 0 && !showAdhoc && (
                  <div className="list-row small muted">
                    {query ? <>Nothing installed matches “{q.trim()}”.</> : <>No known tools detected on your PATH yet.</>}
                  </div>
                )}
              </>
            )}
          </div>
          {available.length > 0 && (
            <div className="row between wrap-gap" style={{ marginTop: 12 }}>
              <span className="small muted">
                {available.length} more {available.length === 1 ? 'tool' : 'tools'} Hypergate knows how to use.
              </span>
              <button className="btn sm" onClick={() => setOffering((v) => !v)}>
                {offering ? 'Close' : 'Install a tool'}
              </button>
            </div>
          )}
          {offering && (
            <div className="list" style={{ marginTop: 10 }}>
              {available.map((c) => <CliInstallRow key={c.id} c={c} />)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One tool you could install. `install` in the catalog is written three ways —
 * a shell command, a URL, or a sentence like "Comes with Node.js" — because
 * that is genuinely how these tools are obtained, so each gets the control it
 * deserves: a command you can copy, a link you can open, or plain words.
 */
function CliInstallRow({ c }: { c: CliStatus }) {
  const [copied, copy] = useCopy();
  const hint = c.install?.trim();
  const isUrl = !!hint && /^https?:\/\//i.test(hint);
  // A command, as opposed to prose: no spaces around a sentence, and it starts
  // with something you'd actually type.
  const isCommand = !!hint && !isUrl && /^(npm|npx|pnpm|yarn|bun|brew|pipx|pip|winget|choco|scoop|apt|cargo|go) /i.test(hint);

  return (
    <div className="list-row">
      <div className="row between wrap-gap">
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="row wrap-gap" style={{ gap: 8 }}>
            <span className="server-name">{c.name}</span>
            <span className="chip mono">{c.command}</span>
            <span className="chip">{c.category}</span>
          </div>
          {c.description && <div className="small muted" style={{ marginTop: 3 }}>{c.description}</div>}
          {hint && !isUrl && !isCommand && <div className="small muted" style={{ marginTop: 3 }}>{hint}</div>}
        </div>
        <div className="row">
          {isCommand && (
            <>
              <code className="chip mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</code>
              <button className="btn sm" onClick={() => copy(`cli-${c.id}`, hint)}>
                {copied === `cli-${c.id}` ? 'Copied!' : 'Copy'}
              </button>
            </>
          )}
          {isUrl && <a className="btn sm" href={hint} target="_blank" rel="noreferrer">Get it ↗</a>}
          {c.homepage && !isUrl && <a className="small muted" href={c.homepage} target="_blank" rel="noreferrer">docs</a>}
        </div>
      </div>
    </div>
  );
}

/** One tool you have. Only ever rendered for a detected CLI. */
function CliRow({ c }: { c: CliStatus }) {
  return (
    <div className="list-row">
      <div className="row between wrap-gap">
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="row wrap-gap" style={{ gap: 8 }}>
            <span className="pill pill-ready"><span className="dot" />installed</span>
            <span className="server-name">{c.name}</span>
            <span className="chip mono">{c.command}</span>
            <span className="chip">{c.category}</span>
            {c.version && <span className="small muted">v{c.version}</span>}
          </div>
          {c.description && <div className="small muted" style={{ marginTop: 3 }}>{c.description}</div>}
          {c.path && <div className="small muted mono" style={{ marginTop: 3, wordBreak: 'break-all' }}>{c.path}</div>}
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
