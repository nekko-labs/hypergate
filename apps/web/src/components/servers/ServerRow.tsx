import { useState } from 'react';
import type { ServerStatus } from '@hypergate/shared';
import { api } from '../../api';
import { RUNTIME_CHIP, STATE_PILL, openAuth } from '../../lib/format';
import { useToast } from '../../toast';
import { ToolList } from '../ToolList';
import { LogConsole } from '../LogConsole';

export function ServerRow({ s, onChange, onToken }: { s: ServerStatus; onChange: () => void; onToken: (server: ServerStatus) => void }) {
  const [logs, setLogs] = useState<string[] | null>(null);
  const [showTools, setShowTools] = useState(false);
  const toast = useToast();
  const busy = s.state === 'starting';
  const isRemote = s.runtime === 'remote';
  const authorizing = s.state === 'authorizing';

  const act = async (action: 'start' | 'stop' | 'restart') => {
    const verb = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }[action];
    try {
      await api.action(s.id, action);
      toast.show(`${verb.replace(/ing$/, 'ed')} ${s.name}`, 'success');
    } catch {
      toast.show(`Could not ${action} ${s.name}`, 'error');
    }
    onChange();
  };
  const signIn = async () => {
    if (s.auth === 'token') {
      onToken(s);
      return;
    }
    const st = await api.authorize(s.id).catch(() => null);
    if (st?.authUrl) openAuth(st.authUrl);
    else toast.show(`Could not start sign-in for ${s.name}`, 'error');
    onChange();
  };
  const remove = async () => {
    try {
      await api.remove(s.id);
      toast.show(`Removed ${s.name}`, 'success');
    } catch {
      toast.show(`Could not remove ${s.name}`, 'error');
    }
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
          <span className="chip">{RUNTIME_CHIP[s.runtime] ?? '💻 local'}</span>
          {isRemote && s.url && <span className="chip mono" title={s.url}>{new URL(s.url).host}</span>}
          {s.state === 'ready' && (
            <button className="link-btn" onClick={() => setShowTools(!showTools)}>{s.tools.length} tools {showTools ? '▾' : '▸'}</button>
          )}
          {s.restarts > 0 && <span className="chip">{s.restarts} restarts</span>}
        </div>
        <div className="row">
          {authorizing ? (
            <button className="btn sm btn-primary" onClick={() => void signIn()}>{s.auth === 'token' ? '🔑 Enter token' : '🔐 Sign in'}</button>
          ) : s.state === 'ready' ? (
            <button className="btn sm btn-warn" onClick={() => void act('stop')}>Stop</button>
          ) : (
            <button className="btn sm btn-go" onClick={() => void act('start')} disabled={busy}>{busy ? 'Starting…' : 'Start'}</button>
          )}
          {!authorizing && <button className="btn sm btn-warn" onClick={() => void act('restart')}>Restart</button>}
          <button className="btn sm" onClick={() => void toggleLogs()}>Logs</button>
          <button className="btn sm btn-danger" onClick={() => void remove()}>{isRemote ? 'Remove & sign out' : 'Remove'}</button>
        </div>
      </div>
      {authorizing && (
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          {s.auth === 'token' ? <>Paste a new token to reconnect {s.name}.</> : <>Waiting for sign-in. Click <b>Sign in</b> to open {s.name}'s login in a new window — it connects automatically once you authorize.</>}
        </p>
      )}
      {s.error && !authorizing && <p className="small" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>{s.error}</p>}
      {showTools && s.tools.length > 0 && (
        <ToolList serverId={s.id} tools={s.toolDetails ?? s.tools.map((name) => ({ name }))} />
      )}
      {logs && <div style={{ marginTop: 10 }}><LogConsole lines={logs} /></div>}
    </div>
  );
}
