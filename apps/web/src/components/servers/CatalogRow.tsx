import { useState } from 'react';
import { registryConnections, resolveRegistryConnection, type RegistryEntry } from '@hypergate/shared';
import { RUNTIME_CHIP } from '../../lib/format';

/** One catalog row (curated or registry-search result) with an Add button. */
export function CatalogRow({ e, onPick }: { e: RegistryEntry; onPick: (e: RegistryEntry) => void }) {
  const options = registryConnections(e);
  const [selectedId, setSelectedId] = useState(options[0]?.id);
  const selected = resolveRegistryConnection(e, selectedId);
  const selectedOption = options.find((option) => option.id === selectedId) ?? options[0];
  const runnable = selected.runnable !== false;
  const oauth = selected.runtime === 'remote' && selected.auth === 'oauth';
  const token = selected.runtime === 'remote' && selected.auth === 'token';
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
            <span className="chip">{RUNTIME_CHIP[selected.runtime] ?? '💻 local'}</span>
            {oauth && <span className="chip chip-accent">🔐 OAuth</span>}
            {token && <span className="chip chip-accent">🔑 Token</span>}
            {selected.source === 'registry' && <span className="chip chip-accent">registry</span>}
            {(selected.requires ?? []).map((r) => <span key={r} className="chip mono">{r}</span>)}
          </div>
          {e.description && <div className="small muted" style={{ marginTop: 3 }}>{e.description}</div>}
          {selectedOption?.description && <div className="small muted" style={{ marginTop: 3 }}>{selectedOption.description}</div>}
          {selected.note && <div className="small" style={{ marginTop: 3, color: 'var(--warning)' }}>{selected.note}</div>}
          {options.length > 1 && (
            <div className="seg" role="radiogroup" aria-label={`${e.name} connection method`} style={{ marginTop: 8, maxWidth: '100%', flexWrap: 'wrap' }}>
              {options.map((option) => (
                <button key={option.id} type="button" className={option.id === selectedId ? 'active' : ''} role="radio" aria-checked={option.id === selectedId} onClick={() => setSelectedId(option.id)} title={option.description}>
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="row">
          {e.homepage && <a className="small muted" href={e.homepage} target="_blank" rel="noreferrer">docs</a>}
          <button className="btn btn-catalog-add" onClick={() => onPick(selected)} disabled={!runnable} title={runnable ? '' : selected.note ?? 'Not locally runnable'}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
