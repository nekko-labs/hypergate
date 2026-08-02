import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProxy, type ProxyUpstream } from './proxy.js';

/** A stand-in for the resident daemon's gateway, recording what reached it. */
const upstream = (): ProxyUpstream & { calls: { name: string; arguments?: unknown }[]; fail?: string } => {
  const stub = {
    calls: [] as { name: string; arguments?: unknown }[],
    fail: undefined as string | undefined,
    async listTools() {
      return {
        tools: [
          { name: 'echo__echo', description: '[echo] say it back', inputSchema: { type: 'object' } },
          { name: 'notes__search', description: '[notes] find a note', inputSchema: { type: 'object' } },
        ],
      };
    },
    async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
      stub.calls.push(params);
      if (stub.fail) throw new Error(stub.fail);
      return { content: [{ type: 'text', text: `ran ${params.name}` }] };
    },
  };
  return stub;
};

/** Wire a proxy to a real MCP client over an in-memory transport pair. */
const connect = async (up: ProxyUpstream): Promise<Client> => {
  const proxy = createProxy(up, { name: 'hypergate-gateway', version: '0.13.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(clientSide);
  return client;
};

describe('createProxy', () => {
  it('passes the resident gateway\'s tools through untouched', async () => {
    const client = await connect(upstream());
    const { tools } = await client.listTools();
    // Namespacing belongs to the gateway that owns the servers; a proxy that
    // re-derived names would be a second source of truth for them.
    expect(tools.map((t) => t.name)).toEqual(['echo__echo', 'notes__search']);
    expect(tools[0].description).toBe('[echo] say it back');
  });

  it('forwards a call with its arguments and returns the upstream result', async () => {
    const up = upstream();
    const client = await connect(up);
    const res = await client.callTool({ name: 'echo__echo', arguments: { text: 'hi' } });
    expect(up.calls).toEqual([{ name: 'echo__echo', arguments: { text: 'hi' } }]);
    expect(res).toMatchObject({ content: [{ type: 'text', text: 'ran echo__echo' }] });
  });

  it('sends an empty object when a tool takes no arguments', async () => {
    const up = upstream();
    const client = await connect(up);
    await client.callTool({ name: 'notes__search' });
    expect(up.calls[0].arguments).toEqual({});
  });

  it("surfaces the upstream's own refusal rather than inventing one", async () => {
    const up = upstream();
    up.fail = 'Not permitted: this client may not call server "github".';
    const client = await connect(up);
    await expect(client.callTool({ name: 'github__list' })).rejects.toThrow(/Not permitted/);
  });

  it('reports no tools when the resident gateway has none', async () => {
    const client = await connect({
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return {};
      },
    });
    expect((await client.listTools()).tools).toEqual([]);
  });
});
