import { useState } from 'react';
import type { ToolInfo } from '@hypergate/shared';
import type { JsonSchema } from '../types';

/** Clickable list of a server's tools; each row expands to its description + parameters. */
export function ToolList({ serverId, tools }: { serverId: string; tools: ToolInfo[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="tool-list">
      {tools.map((t) => {
        const isOpen = open === t.name;
        return (
          <div key={t.name} className={`tool-item ${isOpen ? 'open' : ''}`}>
            <button className="tool-head" onClick={() => setOpen(isOpen ? null : t.name)}>
              <span className="tool-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="tool-name mono">{serverId}__{t.name}</span>
              {t.description && <span className="tool-desc small muted">{t.description}</span>}
            </button>
            {isOpen && (
              <div className="tool-detail">
                {t.description && <p className="tool-detail-desc">{t.description}</p>}
                <SchemaParams schema={t.inputSchema} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Render an MCP tool's inputSchema as a compact parameter list. */
function SchemaParams({ schema }: { schema: unknown }) {
  const s = (schema && typeof schema === 'object' ? schema : {}) as JsonSchema;
  const props = s.properties ?? {};
  const names = Object.keys(props);
  const required = new Set(s.required ?? []);
  if (names.length === 0) return <div className="small muted tool-noparams">No parameters.</div>;
  return (
    <div className="params">
      <div className="params-label small muted">Parameters</div>
      {names.map((name) => {
        const p = props[name] ?? {};
        return (
          <div key={name} className="param-row">
            <span className="param-name mono">{name}</span>
            {p.type && <span className="param-type chip mono">{p.type}</span>}
            {required.has(name) && <span className="param-req">required</span>}
            {p.description && <span className="param-desc small muted">{p.description}</span>}
          </div>
        );
      })}
    </div>
  );
}
