import { useState } from 'react';
import type { ManagedServerConfig, RegistryEntry, RuntimeKind } from '@hypergate/shared';
import { api } from '../../api';
import { useToast } from '../../toast';
import { Dialog } from '../Dialog';

export function AddServerDialog({ entry, onClose, onAdded }: { entry: RegistryEntry | null; onClose: () => void; onAdded: () => void }) {
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
    }
    setBusy(false);
  };

  return (
    <Dialog
      title={entry ? `Add ${entry.name}` : 'Add a custom server'}
      onClose={onClose}
      description={entry?.description}
    >
      <div className="row" style={{ marginTop: 4, flexWrap: 'wrap', gap: 14 }}>
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
        <span className="small" style={{ color: 'var(--danger)' }} role="alert">{err}</span>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={(runtime === 'docker' ? !image && !command : !command) || busy}>{busy ? 'Adding…' : 'Add & start'}</button>
      </div>
    </Dialog>
  );
}
