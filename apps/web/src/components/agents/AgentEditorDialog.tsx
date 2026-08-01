import { useState } from 'react';
import type { AgentClientInfo, ServerStatus } from '@hypergate/shared';
import { api } from '../../api';
import { useToast } from '../../toast';
import { Dialog } from '../Dialog';

export function AgentEditorDialog({ agent, servers, onClose, onSaved }: { agent: AgentClientInfo | null; servers: ServerStatus[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(agent?.name ?? '');
  const [all, setAll] = useState(agent ? agent.servers === '*' : true);
  const [sel, setSel] = useState<Set<string>>(new Set(agent && agent.servers !== '*' ? agent.servers : []));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

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
      if (agent) await api.updateClient(agent.id, { name: name.trim(), servers: scoped });
      else await api.addClient({ name: name.trim(), servers: scoped });
      toast.show(agent ? `Saved ${name.trim()}` : `Created agent ${name.trim()}`, 'success');
      onSaved();
    } catch {
      setErr('Could not save the agent, check the daemon logs.');
    }
    setBusy(false);
  };

  return (
    <Dialog title={agent ? `Edit ${agent.name}` : 'Add a connected agent'} onClose={onClose} width={480}>
      <label className="field" style={{ marginTop: 4, maxWidth: 320 }}>
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
        <span className="small" style={{ color: 'var(--danger)' }} role="alert">{err}</span>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : agent ? 'Save' : 'Create agent'}</button>
      </div>
    </Dialog>
  );
}
