import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Supervisor } from './supervisor.js';
import { createGateway, NS } from './gateway.js';
import type { ManagedServerConfig } from '@hypergate/shared';

const echoPath = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));
const echoConfig: ManagedServerConfig = {
  id: 'echo',
  name: 'Echo',
  runtime: 'process',
  command: process.execPath, // node
  args: [echoPath],
  enabled: true,
};

const supervisor = new Supervisor();
afterAll(async () => {
  await supervisor.stopAll();
});

describe('Supervisor + Gateway (end-to-end via process runtime)', () => {
  it('starts a stdio MCP server as a sandboxed process and reports its tools', async () => {
    const status = await supervisor.start(echoConfig);
    expect(status.state).toBe('ready');
    expect(status.tools).toContain('echo');
  });

  it('aggregates the server through the gateway with a namespaced tool', async () => {
    const gateway = createGateway(supervisor);
    const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
    await gateway.connect(gwSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(`echo${NS}echo`);

    const res = (await client.callTool({ name: `echo${NS}echo`, arguments: { text: 'hello nekko' } })) as {
      content: { type: string; text: string }[];
    };
    expect(res.content[0].text).toBe('hello nekko');
    await client.close();
  });

  it('records the call in usage analytics (server, tool, client, bytes)', async () => {
    const gateway = createGateway(supervisor, { name: 'gw', version: '0' }, { caller: 'test-harness 1.0' });
    const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
    await gateway.connect(gwSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);
    await client.callTool({ name: `echo${NS}echo`, arguments: { text: 'measure me' } });
    await client.close();

    const a = supervisor.analytics();
    expect(a.totalCalls).toBeGreaterThan(0);
    const echo = a.servers.find((s) => s.serverId === 'echo');
    expect(echo?.tools.some((t) => t.tool === 'echo')).toBe(true);
    expect(echo!.bytesIn).toBeGreaterThan(0);
    expect(a.clients.some((c) => c.client === 'test-harness 1.0')).toBe(true);
  });

  it('scopes an agent: a denied server is hidden from tools/list and refused on tools/call', async () => {
    // allowServer denies everything → echo's tool must not appear and must be refused.
    const gateway = createGateway(supervisor, { name: 'gw', version: '0' }, { caller: 'scoped-agent', allowServer: () => false });
    const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
    await gateway.connect(gwSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain(`echo${NS}echo`);

    await expect(client.callTool({ name: `echo${NS}echo`, arguments: { text: 'blocked' } })).rejects.toThrow(/not permitted/i);
    await client.close();
  });

  it('does not leak the host env into the sandboxed child', async () => {
    // The supervisor only forwards an allow-listed base env + declared vars,
    // so an ambient secret set in this process must not reach the child.
    process.env.HYPERGATE_SECRET_LEAK_TEST = 'should-not-pass';
    // (echo server doesn't expose env, but the runtime spec is what we assert)
    const { ProcessRuntime } = await import('./runtime.js');
    const spec = new ProcessRuntime().spawnSpec(echoConfig);
    expect(spec.env.HYPERGATE_SECRET_LEAK_TEST).toBeUndefined();
    delete process.env.HYPERGATE_SECRET_LEAK_TEST;
  });
});
