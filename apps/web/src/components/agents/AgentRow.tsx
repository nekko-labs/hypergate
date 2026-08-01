import { useState } from 'react';
import type { AgentClientInfo, ServerStatus } from '@hypergate/shared';
import { api } from '../../api';
import { fmtRel } from '../../lib/format';
import { useCopy } from '../../lib/useCopy';
import { useToast } from '../../toast';

export function AgentRow({ agent, servers, onEdit, onChange }: { agent: AgentClientInfo; servers: ServerStatus[]; onEdit: () => void; onChange: () => void }) {
  const [copied, copy] = useCopy();
  const [show, setShow] = useState(false);
  const toast = useToast();
  const nameFor = (id: string) => servers.find((s) => s.id === id)?.name ?? id;
  const all = agent.servers === '*';
  const ids = agent.servers === '*' ? [] : agent.servers;
  const remove = async () => {
    try {
      await api.removeClient(agent.id);
      toast.show(`Removed agent ${agent.name}`, 'success');
    } catch {
      toast.show(`Could not remove ${agent.name}`, 'error');
    }
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
          <button className="btn sm" onClick={() => copy(`tok-${agent.id}`, agent.token, 'Agent token copied')}>{copied === `tok-${agent.id}` ? 'Copied!' : 'Copy token'}</button>
          <button className="btn sm" onClick={() => copy(`cmd-${agent.id}`, agent.connectCommand, 'Connect command copied')}>{copied === `cmd-${agent.id}` ? 'Copied!' : 'Copy connect'}</button>
        </div>
        <div className="row">
          <span className="small muted">{agent.lastUsed ? `used ${fmtRel(agent.lastUsed)}` : 'never used'}</span>
          <button className="btn sm" onClick={onEdit}>Edit</button>
          <button className="btn sm btn-danger" onClick={() => void remove()}>Remove</button>
        </div>
      </div>
      <div className="perm-row">
        <span className="small muted">can use</span>
        {all ? (
          <span className="chip chip-accent">all servers</span>
        ) : ids.length === 0 ? (
          <span className="chip" style={{ color: 'var(--danger)' }}>no servers (blocked)</span>
        ) : (
          ids.map((id) => <span key={id} className="chip">{nameFor(id)}</span>)
        )}
      </div>
    </div>
  );
}
