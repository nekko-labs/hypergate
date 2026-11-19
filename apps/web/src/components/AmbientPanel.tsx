import { useCallback, useEffect, useState } from 'react';
import type { AmbientFinding, WatchEvent } from '@hypergate/shared';
import { ambientApi } from '../ambientApi';
import { useToast } from '../toast';

const shortPath = (p: string): string => p.replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');

const EVENT_LABEL: Record<WatchEvent['kind'], string> = {
  'ambient-new': 'new login',
  'ambient-changed': 'login changed',
  'ambient-imported': 'moved to vault',
  'cli-new': 'new CLI',
};

/** What the action button does for a finding, or undefined for report-only rows. */
const actionFor = (f: AmbientFinding): string | undefined => {
  if (!f.importable) return undefined;
  return f.removal === 'manual' ? 'Copy into vault' : 'Move into vault';
};

/**
 * Ambient logins: keys tools keep for themselves outside the vault, which any
 * process running as you (an agent included) can read. Sits in the Credentials
 * section because the fix for each row is a vault credential.
 */
export function AmbientPanel({ token, onImported }: { token?: string; onImported: () => void }) {
  const [findings, setFindings] = useState<AmbientFinding[] | null>(null);
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    void ambientApi.scan().then((r) => setFindings(r.findings)).catch(() => setFindings([]));
    void ambientApi.events().then((r) => setEvents(r.events.slice(-6).reverse())).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    // The watcher runs in the daemon whether or not this is open; polling here
    // only keeps the list honest while someone is looking at it.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const move = async (f: AmbientFinding) => {
    if (!token) return;
    setBusy(f.id);
    try {
      const r = await ambientApi.importFinding(f.id, token);
      const where = r.vault === 'rolled' ? 'rolled into' : r.vault === 'unchanged' ? 'already in' : 'stored as';
      toast.show(
        r.removed
          ? `${f.tool}: ${where} ${r.credentialId}, and removed from ${shortPath(f.location)}`
          : `${f.tool}: ${where} ${r.credentialId}. ${r.manualStep ?? ''}`,
        r.removed ? 'success' : 'info',
      );
      load();
      onImported();
    } catch (e) {
      toast.show(`Could not move it: ${e instanceof Error ? e.message : 'error'}`, 'error');
    }
    setBusy(null);
  };

  if (findings === null) return null;
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="row between wrap-gap" style={{ marginBottom: 6 }}>
        <span className="server-name">
          {findings.length === 0
            ? 'No logins found outside the vault'
            : `${findings.length} login${findings.length === 1 ? '' : 's'} outside the vault`}
        </span>
        <span className="row" style={{ gap: 8 }}>
          <span className="small muted">Any process running as you can read these, agents included.</span>
          <button className="btn sm" onClick={load}>Scan again</button>
        </span>
      </div>
      {findings.length > 0 && (
        <div className="list">
          {findings.map((f) => {
            const action = actionFor(f);
            return (
              <div key={f.id} className="list-row">
                <div className="row between wrap-gap">
                  <div className="row wrap-gap" style={{ gap: 8, flex: 1, minWidth: 220 }}>
                    <span className="server-name">{f.tool}</span>
                    {f.detail && <span className="chip">{f.detail}</span>}
                    <span className="small muted mono" title={f.location} style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                      {shortPath(f.location)}
                    </span>
                    {f.hint && <span className="small muted mono">{f.hint}</span>}
                    {f.storage === 'keyring' && <span className="chip">OS keyring</span>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm btn-ghost" onClick={() => setOpen(open === f.id ? null : f.id)}>
                      {open === f.id ? 'Less' : 'Details'}
                    </button>
                    {action ? (
                      <button className="btn sm btn-primary" disabled={!token || busy === f.id} onClick={() => void move(f)}>
                        {busy === f.id ? 'Moving…' : action}
                      </button>
                    ) : (
                      <span className="small muted">Manual step</span>
                    )}
                  </div>
                </div>
                {open === f.id && (
                  <div className="small muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
                    {f.removal === 'vendor-logout' && f.removeCommand && (
                      <div>Moving it runs <span className="mono">{f.removeCommand}</span> after the key is in the vault.</div>
                    )}
                    {(f.removal === 'edit' || f.removal === 'delete-file') && (
                      <div>Moving it backs the file up (kept seven days), then takes the value out.</div>
                    )}
                    {f.manualStep && <div>To finish: {f.manualStep}</div>}
                    {f.caveat && <div>Note: {f.caveat}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {events.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>Recently noticed</div>
          <div className="list">
            {events.map((e) => (
              <div key={e.id} className="list-row small">
                <span className="chip">{EVENT_LABEL[e.kind]}</span>{' '}
                <span>{e.detail ? `${e.tool} (${e.detail})` : e.tool}</span>{' '}
                <span className="muted mono" style={{ overflowWrap: 'anywhere' }}>{shortPath(e.location)}</span>{' '}
                {e.quarantined && <span className="chip">quarantined</span>}{' '}
                <span className="muted">{new Date(e.at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
