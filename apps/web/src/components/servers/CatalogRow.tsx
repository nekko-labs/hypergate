import type { RegistryEntry } from '@hypergate/shared';
import { RUNTIME_CHIP } from '../../lib/format';

/** One catalog row (curated or registry-search result) with an Add button. */
export function CatalogRow({ e, onPick }: { e: RegistryEntry; onPick: (e: RegistryEntry) => void }) {
  const runnable = e.runnable !== false;
  const oauth = e.runtime === 'remote' && e.auth === 'oauth';
  const token = e.runtime === 'remote' && e.auth === 'token';
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
            <span className="chip">{RUNTIME_CHIP[e.runtime] ?? '⚡ process'}</span>
            {oauth && <span className="chip chip-accent">🔐 OAuth</span>}
            {token && <span className="chip chip-accent">🔑 Token</span>}
            {e.source === 'registry' && <span className="chip chip-accent">registry</span>}
            {(e.requires ?? []).map((r) => <span key={r} className="chip mono">{r}</span>)}
          </div>
          {e.description && <div className="small muted" style={{ marginTop: 3 }}>{e.description}</div>}
          {e.note && <div className="small" style={{ marginTop: 3, color: 'var(--warning)' }}>{e.note}</div>}
        </div>
        <div className="row">
          {e.homepage && <a className="small muted" href={e.homepage} target="_blank" rel="noreferrer">docs</a>}
          <button className={`btn ${oauth || token ? 'btn-primary' : ''}`} onClick={() => onPick(e)} disabled={!runnable} title={runnable ? '' : e.note ?? 'Not locally runnable'}>
            {oauth ? '🔐 Sign in & add' : token ? '🔑 Add with token' : '+ Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
