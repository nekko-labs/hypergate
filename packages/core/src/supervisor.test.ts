import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ManagedServerConfig } from '@hypergate/shared';
import { Supervisor } from './supervisor.js';

describe('Supervisor remote bearer auth', () => {
  it('attaches the injected bearer header without an OAuth provider', async () => {
    const config: ManagedServerConfig = {
      id: 'token-server',
      name: 'Token server',
      runtime: 'remote',
      command: '',
      url: '',
      transport: 'http',
      auth: 'token',
      enabled: true,
    };
    const supervisor = new Supervisor({
      authHeadersFor: () => ({ Authorization: 'Bearer test-token' }),
      authProviderFor: () => { throw new Error('OAuth provider must not be requested for token auth'); },
    });
    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(req.headers.authorization ?? '');
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body) as { method?: string; id?: string | number };
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } }
        : { tools: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    config.url = `http://127.0.0.1:${address.port}/mcp`;

    const status = await supervisor.start(config);
    expect(status.state).toBe('ready');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === 'Bearer test-token')).toBe(true);
    expect(status.tools).toEqual([]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }, 15000);
});
