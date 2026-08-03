import { useEffect, useMemo, useRef, useState } from 'react';
import type { RegistryEntry, PopularityMap } from '@hypergate/shared';
import { api } from '../../api';
import { sortCatalog } from '../../lib/format';
import { Dialog } from '../Dialog';
import { CatalogRow } from './CatalogRow';

/**
 * The "Add server" dialog: search the official MCP registry, or pick from the
 * curated list (or configure a custom server). `onPick` hands the chosen entry
 * back to the parent, which opens the configure dialog / OAuth flow.
 */
export function AddCatalogDialog({
  curated,
  onPick,
  onClose,
}: {
  curated: RegistryEntry[];
  onPick: (e: RegistryEntry | 'custom') => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RegistryEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  // Popularity is fetched here — i.e. only when the catalog is opened — so the
  // daemon never reaches out on boot. The recommended set shows first instantly
  // (authored order); the rest re-sort by popularity once it arrives.
  const [pop, setPop] = useState<PopularityMap>({});
  useEffect(() => { void api.popularity().then(setPop).catch(() => {}); }, []);
  const sortedCurated = useMemo(() => sortCatalog(curated, pop), [curated, pop]);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void api
        .searchRegistry(query)
        .then((r) => { if (mine === seq.current) setResults(r); })
        .catch(() => { if (mine === seq.current) setResults([]); })
        .finally(() => { if (mine === seq.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const searchingLive = q.trim().length > 0;
  return (
    <Dialog
      title="Add a server"
      width={640}
      onClose={onClose}
      description="Search the official MCP registry, pick a curated server, or configure a custom one."
    >
      <div className="panel">
        <div className="catalog-search">
          <span className="cs-ic">🔎</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the official MCP registry (github, postgres, slack…)"
            aria-label="Search the MCP registry"
          />
          {searching && <span className="small muted">searching…</span>}
          {q && <button className="btn sm btn-ghost" onClick={() => setQ('')}>Clear</button>}
        </div>
        <div className="list catalog-scroll">
          {searchingLive ? (
            results && results.length > 0 ? (
              results.map((e) => <CatalogRow key={e.id} e={e} onPick={onPick} />)
            ) : !searching ? (
              <div className="list-row small muted">No servers found in the registry for “{q.trim()}”.</div>
            ) : (
              <div className="list-row small muted">Searching the MCP registry…</div>
            )
          ) : (
            <>
              {sortedCurated.map((e) => <CatalogRow key={e.id} e={e} onPick={onPick} />)}
              <div className="list-row">
                <div className="row between wrap-gap">
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <span className="server-name">Custom server</span>
                    <div className="small muted" style={{ marginTop: 3 }}>Any stdio MCP server, by command (local) or image (Docker).</div>
                  </div>
                  <button className="btn btn-primary" onClick={() => onPick('custom')}>+ Configure</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
