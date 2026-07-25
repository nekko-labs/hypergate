import { useState } from 'react';
import type { AgentClientInfo, ServerStatus } from '@hypergate/shared';
import { AgentRow } from './AgentRow';
import { AgentEditorDialog } from './AgentEditorDialog';

/** "Connected agents": scoped gateway tokens, each with its per-server permissions listed underneath. */
export function ConnectedAgents({ agents, servers, onChange }: { agents: AgentClientInfo[]; servers: ServerStatus[]; onChange: () => void }) {
  const [editing, setEditing] = useState<AgentClientInfo | 'new' | null>(null);
  return (
    <>
      <div className="section-title">
        Connected agents
        <span className="rt">
          <button className="btn sm btn-accent" onClick={() => setEditing('new')}>+ Add agent</button>
        </span>
      </div>
      {agents.length === 0 ? (
        <div className="panel"><div className="list-row small muted">
          No scoped agents yet. Add one to hand a specific client a token that only reaches the servers you allow — the master gateway token above always has full access.
        </div></div>
      ) : (
        <div className="panel"><div className="list">
          {agents.map((a) => <AgentRow key={a.id} agent={a} servers={servers} onEdit={() => setEditing(a)} onChange={onChange} />)}
        </div></div>
      )}
      {editing && (
        <AgentEditorDialog
          agent={editing === 'new' ? null : editing}
          servers={servers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChange(); }}
        />
      )}
    </>
  );
}
