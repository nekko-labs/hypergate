import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Supervisor } from './supervisor.js';
import { createGateway, NS, BUILTIN_NS, type GatewayBuiltinTool } from './gateway.js';
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

  it("carries a proxied tool's title and behavioural hints across the hop", async () => {
    const gateway = createGateway(supervisor);
    const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
    await gateway.connect(gwSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    const peek = tools.find((t) => t.name === `echo${NS}peek`);
    expect(peek).toBeDefined();
    // The hints are the point: a client reads readOnlyHint to decide whether a
    // call needs the user's approval, so aggregation must not drop them.
    expect(peek!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // The display label is namespaced like the description, so two servers'
    // identically-titled tools stay tellable apart.
    expect(peek!.title).toBe('[echo] Peek at the text');
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

  it('seats a stopped server in the roster with register(), and can still start it', async () => {
    // A server the user stopped must survive a daemon restart: the daemon seats
    // disabled configs so /api/servers (which is list()) still shows them.
    const disabled: ManagedServerConfig = { ...echoConfig, id: 'echo-off', name: 'Echo (off)', enabled: false };
    const seated = supervisor.register(disabled);
    expect(seated.state).toBe('stopped');
    expect(seated.tools).toEqual([]);
    expect(supervisor.list().map((s) => s.id)).toContain('echo-off');
    // Nothing was spawned, so the gateway has no client for it yet.
    expect(supervisor.client('echo-off')).toBeUndefined();

    // Registering twice must not reset a running server or duplicate the entry.
    const before = supervisor.list().length;
    supervisor.register(disabled);
    expect(supervisor.list().length).toBe(before);

    const started = await supervisor.start({ ...disabled, enabled: true });
    expect(started.state).toBe('ready');
    expect(started.tools).toContain('echo');
    await supervisor.stop('echo-off');
    expect(supervisor.status('echo-off')?.state).toBe('stopped');
  });

  it('serves builtin tools under the reserved hypergate namespace, recorded like routed calls', async () => {
    const builtins: GatewayBuiltinTool[] = [
      {
        name: 'credentials_list',
        title: 'List vault credentials',
        description: 'List the credentials this caller may fetch.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {} },
        call: () => [{ id: 'fly-token', envVar: 'FLY_API_TOKEN' }],
      },
      {
        name: 'credential_env',
        description: 'Fetch one credential as env.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        call: (args) => {
          if (args.id !== 'fly-token') throw new Error('Not permitted: this client may not fetch that credential.');
          return { env: { FLY_API_TOKEN: 'v' } };
        },
      },
    ];
    const gateway = createGateway(supervisor, { name: 'gw', version: '0' }, { caller: 'vault-agent', builtins });
    const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
    await gateway.connect(gwSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    // Builtins appear alongside the aggregated tools, namespaced hypergate__*.
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(`${BUILTIN_NS}${NS}credentials_list`);
    expect(names).toContain(`echo${NS}echo`);

    // A builtin's own title and hints reach the client the same way.
    const listTool = tools.find((t) => t.name === `${BUILTIN_NS}${NS}credentials_list`);
    expect(listTool!.title).toBe(`[${BUILTIN_NS}] List vault credentials`);
    expect(listTool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const listed = (await client.callTool({ name: `${BUILTIN_NS}${NS}credentials_list`, arguments: {} })) as {
      content: { type: string; text: string }[];
    };
    expect(JSON.parse(listed.content[0].text)[0].id).toBe('fly-token');

    const env = (await client.callTool({ name: `${BUILTIN_NS}${NS}credential_env`, arguments: { id: 'fly-token' } })) as {
      content: { type: string; text: string }[];
    };
    expect(JSON.parse(env.content[0].text).env.FLY_API_TOKEN).toBe('v');

    // A refusal thrown by the builtin surfaces as a tool error and is recorded.
    await expect(client.callTool({ name: `${BUILTIN_NS}${NS}credential_env`, arguments: { id: 'nope' } })).rejects.toThrow(/not permitted/i);
    await client.close();

    const hg = supervisor.analytics().servers.find((s) => s.serverId === BUILTIN_NS);
    expect(hg?.tools.some((t) => t.tool === 'credential_env')).toBe(true);
    expect(hg!.errors).toBeGreaterThan(0);
    expect(hg!.clients).toContain('vault-agent');
  });

  it('a gateway with no builtins neither lists nor answers hypergate__* tools', async () => {
    const gateway = createGateway(supervisor);
    const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
    await gateway.connect(gwSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith(`${BUILTIN_NS}${NS}`))).toBe(false);
    await expect(client.callTool({ name: `${BUILTIN_NS}${NS}credentials_list`, arguments: {} })).rejects.toThrow(/unknown tool/i);
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
