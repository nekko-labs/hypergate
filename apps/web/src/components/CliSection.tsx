import { useEffect, useRef, useState } from 'react';
import type { CliStatus, CliCheckResult } from '@hypergate/shared';
import { api } from '../api';

/**
 * "Command-line tools": which CLIs are installed on this machine (many MCP
 * servers need one — `uvx` for Python servers, `docker` for the Docker runtime,
 * `flyctl` for Fly, `kotrain` for the Kotrain server) plus a quick search to
 * check any command. Local + shell-free; nothing leaves the machine.
 */
export function CliSection() {
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
