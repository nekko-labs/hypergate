import type { AnalyticsSummary } from '@hypergate/shared';
import { fmtNum, fmtBytes, fmtRel, fmtClock } from '../lib/format';
import { EmptyState } from '../components/EmptyState';

export function AnalyticsView({ stats }: { stats: AnalyticsSummary | null }) {
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

      {stats === null ? (
        // Loading — mirrors the Servers list's loading treatment (shared EmptyState).
        <EmptyState glyph="📡" title="Loading analytics…" loading>
          Reading the gateway's local call log. This stays on your machine.
        </EmptyState>
      ) : !hasData ? (
        <EmptyState glyph="📡" title="No calls yet.">
          Connect an agent to the gateway and start a server. Every tool call it makes will appear here — with the caller, latency, and data volume.
        </EmptyState>
      ) : (
        <>
          <div className="metricbar">
            <div className="metric accent"><div className="m-val">{fmtNum(stats.totalCalls)}</div><div className="m-label">tool calls</div></div>
            <div className="metric"><div className="m-val">{successRate}<span className="u">%</span></div><div className="m-label">success rate</div></div>
            <div className="metric"><div className="m-val">{stats.clients.length}</div><div className="m-label">clients</div></div>
            <div className="metric"><div className="m-val">{fmtBytes(stats.bytesIn)}</div><div className="m-label">data in</div></div>
            <div className="metric"><div className="m-val">{fmtBytes(stats.bytesOut)}</div><div className="m-label">data out</div></div>
          </div>

          <div className="spark-wrap">
            <div className="small muted" style={{ marginBottom: 2 }}>Calls · last 24h</div>
            <div className="spark">
              {stats.series.map((b, i) => (
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
            {stats.servers.map((s) => (
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
            {stats.clients.map((c) => (
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
            {stats.recent.map((e, i) => (
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
      )}
    </>
  );
}
