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

describe('Supervisor remote HTTP error pages', () => {
  /** A host's error page, shaped like the real ones: a `401` sits in the markup. */
  const errorPage = (status: number) =>
    `<!DOCTYPE html><html><head><title>${status}: Internal Server Error</title>`
    + '<script src="/_next/static/chunks/pages/_error-401cf280a3bb.js" defer=""></script>'
    + `</head><body><h1>${status}</h1></body></html>`;

  /** Boots a server that answers every MCP POST with `status` and an HTML page. */
  const startFailing = async (status: number) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorPage(status));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const config: ManagedServerConfig = {
      id: `html-${status}`,
      name: `HTML ${status}`,
      runtime: 'remote',
      command: '',
      url: `http://127.0.0.1:${address.port}/`,
      transport: 'http',
      auth: 'none',
      enabled: true,
    };
    const close = () =>
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return { config, close };
  };

  it('reports a 500 HTML page as one readable line, not a dump of the page', async () => {
    const { config, close } = await startFailing(500);
    const supervisor = new Supervisor({});

    const status = await supervisor.start(config);

    expect(status.state).toBe('errored');
    expect(status.error).toContain('HTTP 500');
    expect(status.error).not.toContain('<html');
    expect(status.error).not.toContain('_next');
    expect(status.error!.length).toBeLessThan(200);
    // The page itself is still there to debug with, just not as the row's error.
    expect(supervisor.logs(config.id).some((line) => line.includes('_next'))).toBe(true);
    await close();
  }, 15000);

  it('does not read a 500 whose markup happens to contain 401 as an auth challenge', async () => {
    const { config, close } = await startFailing(500);
    const supervisor = new Supervisor({});

    const status = await supervisor.start(config);

    expect(status.state).toBe('errored');
    expect(status.error).not.toMatch(/sign in|token/i);
    await close();
  }, 15000);

  it('still treats a real 401 as authorizing', async () => {
    const { config, close } = await startFailing(401);
    const supervisor = new Supervisor({});

    const status = await supervisor.start(config);

    expect(status.state).toBe('authorizing');
    expect(status.error).toContain('HTTP 401');
    await close();
  }, 15000);
});
