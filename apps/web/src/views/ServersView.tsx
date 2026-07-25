import { useCallback, useState } from 'react';
import type { ServerStatus, RegistryEntry, GatewayInfo, AgentClientInfo } from '@hypergate/shared';
import { api } from '../api';
import { openAuth } from '../lib/format';
import { useToast } from '../toast';
import { GatewayBar } from '../components/GatewayBar';
import { EmptyState } from '../components/EmptyState';
import { ServerRow } from '../components/servers/ServerRow';
import { AddCatalogDialog } from '../components/servers/AddCatalogDialog';
import { AddServerDialog } from '../components/servers/AddServerDialog';
import { ConnectedAgents } from '../components/agents/ConnectedAgents';
import { CliSection } from '../components/CliSection';

export function ServersView({
  servers,
  registry,
  gateway,
  agents,
  refresh,
  refreshAgents,
}: {
  servers: ServerStatus[] | null;
  registry: RegistryEntry[];
  gateway: GatewayInfo | null;
  agents: AgentClientInfo[];
  refresh: () => void;
  refreshAgents: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState<RegistryEntry | 'custom' | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);

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
      toast.show(`Added ${e.name} — sign in to connect`, 'success');
    } catch {
      // Already added (409) or a transient error — (re)start the login instead.
      const status = await api.authorize(e.id).catch(() => null);
      openAuth(status?.authUrl);
    }
    refresh();
  }, [refresh, toast]);

  const handlePick = useCallback((e: RegistryEntry | 'custom') => {
    setShowCatalog(false);
    if (e !== 'custom' && e.runtime === 'remote' && e.auth === 'oauth') { void quickAddOAuth(e); return; }
    setAdding(e);
  }, [quickAddOAuth]);

  return (
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
          <button className="btn sm btn-accent" onClick={() => setShowCatalog(true)}>+ Add server</button>
        </span>
      </div>

      {servers === null ? (
        <EmptyState glyph="🐈" title="Loading servers…" loading>
          Talking to the daemon.
        </EmptyState>
      ) : servers.length === 0 ? (
        <EmptyState
          glyph="🐈"
          title="No servers yet."
          action={<button className="btn btn-primary" onClick={() => setShowCatalog(true)}>+ Add your first server</button>}
        >
          Add one — its tools join the gateway instantly.
        </EmptyState>
      ) : (
        <div className="panel"><div className="list">
          {servers.map((s) => <ServerRow key={s.id} s={s} onChange={refresh} />)}
        </div></div>
      )}

      <ConnectedAgents agents={agents} servers={servers ?? []} onChange={refreshAgents} />

      <CliSection />

      {showCatalog && (
        <AddCatalogDialog curated={registry} onPick={handlePick} onClose={() => setShowCatalog(false)} />
      )}

      {adding && (
        <AddServerDialog
          entry={adding === 'custom' ? null : adding}
          onClose={() => setAdding(null)}
          onAdded={() => { setAdding(null); setShowCatalog(false); refresh(); }}
        />
      )}
    </>
  );
}
