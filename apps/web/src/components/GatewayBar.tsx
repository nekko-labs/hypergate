import { useState } from 'react';
import type { GatewayInfo } from '@hypergate/shared';
import { useCopy } from '../lib/useCopy';

export function GatewayBar({ gateway }: { gateway: GatewayInfo }) {
  const [copied, copy] = useCopy();
  const [showToken, setShowToken] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'claude' | 'json' | 'stdio' | 'openpaw'>('claude');
  const token = gateway.token ?? '';
  const snippets: Record<string, string> = {
    claude: `claude mcp add -t http hypergate ${gateway.url} -H "Authorization: Bearer ${token}"`,
    json: JSON.stringify(gateway.clientSnippet, null, 2),
    stdio: JSON.stringify(gateway.stdioSnippet ?? { mcpServers: { 'hypergate': { command: 'hypergated', args: ['--stdio'] } } }, null, 2),
    openpaw: 'Open Paw auto-detects Hypergate.\nSettings → MCP servers → "Connect Hypergate gateway" — one click, done.',
  };
  return (
    <div className="gwbar">
      <div className="gwbar-row">
        <span className="glabel"><span className="dot-grad" />Gateway</span>
        <span className="url">{gateway.url}</span>
        <button className="btn sm" onClick={() => copy('url', gateway.url, 'Gateway URL copied')}>{copied === 'url' ? 'Copied!' : 'Copy'}</button>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="tok">token {showToken ? token.slice(0, 12) + '…' : '••••••'}</span>
        <button className="btn sm btn-ghost" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</button>
        <button className="btn sm" onClick={() => copy('token', token, 'Gateway token copied')}>{copied === 'token' ? 'Copied!' : 'Copy'}</button>
        <button className={`btn sm ${open ? '' : 'btn-accent'}`} onClick={() => setOpen(!open)}>Connect an agent {open ? '▴' : '▾'}</button>
      </div>
      {open && (
        <div className="connect-panel">
          <div className="tabs">
            <button className={`tab ${tab === 'claude' ? 'active' : ''}`} onClick={() => setTab('claude')}>Claude Code</button>
            <button className={`tab ${tab === 'json' ? 'active' : ''}`} onClick={() => setTab('json')}>.mcp.json</button>
            <button className={`tab ${tab === 'stdio' ? 'active' : ''}`} onClick={() => setTab('stdio')}>stdio</button>
            <button className={`tab ${tab === 'openpaw' ? 'active' : ''}`} onClick={() => setTab('openpaw')}>Open Paw</button>
          </div>
          <pre className="snippet">{snippets[tab]}</pre>
          {tab !== 'openpaw' && (
            <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
              <button className="btn sm" onClick={() => copy('snippet', snippets[tab], 'Snippet copied')}>{copied === 'snippet' ? 'Copied!' : 'Copy snippet'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
