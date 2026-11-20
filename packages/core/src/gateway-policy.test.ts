import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolPolicy, UsageEvent } from '@hypergate/shared';
import { Supervisor } from './supervisor.js';
import { createGateway, NS } from './gateway.js';
import { createSecretGuard, REDACTED, type SecretGuard } from './guard.js';

const echoPath = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));
const supervisor = new Supervisor();
const recorded: UsageEvent[] = [];
const origRecord = supervisor.record.bind(supervisor);
supervisor.record = (e: UsageEvent) => {
  recorded.push(e);
  origRecord(e);
};

beforeAll(async () => {
  await supervisor.start({ id: 'echo', name: 'Echo', runtime: 'process', command: process.execPath, args: [echoPath], enabled: true });
});
afterAll(async () => {
  await supervisor.stopAll();
});

const connect = async (opts: { toolPolicy?: ToolPolicy; guard?: SecretGuard }) => {
  const gateway = createGateway(supervisor, undefined, { caller: 'tester', ...opts });
  const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
  await gateway.connect(gwSide);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(clientSide);
  return client;
};

describe('gateway tool permissions', () => {
  it('read-only lists and calls only tools declared read-only', async () => {
    const client = await connect({ toolPolicy: { readOnly: true } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain(`echo${NS}peek`);
    expect(names).not.toContain(`echo${NS}echo`);
    await expect(client.callTool({ name: `echo${NS}echo`, arguments: { text: 'x' } })).rejects.toThrow(/read-only/);
    const last = recorded.at(-1)!;
    expect(last).toMatchObject({ tool: 'echo', blocked: 'policy', ok: false, client: 'tester', destructive: true });
    const ok = (await client.callTool({ name: `echo${NS}peek`, arguments: { text: 'hi' } })) as { content: { text: string }[] };
    expect(ok.content[0]!.text).toBe('hi');
    expect(recorded.at(-1)!.destructive).toBeUndefined();
    await client.close();
  });

  it('a blocked tool is hidden and refused, its neighbours are not', async () => {
    const client = await connect({ toolPolicy: { blocked: [`echo${NS}peek`] } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([`echo${NS}echo`]));
    expect(names).not.toContain(`echo${NS}peek`);
    await expect(client.callTool({ name: `echo${NS}peek`, arguments: { text: 'x' } })).rejects.toThrow(/blocked/);
    await client.close();
  });
});

describe('gateway secret guard', () => {
  const guard = createSecretGuard(() => [{ label: 'Stripe key', value: 'sk_live_1234567890abcdef' }]);

  it('refuses a call whose arguments carry a vault value, and never records the arguments', async () => {
    const client = await connect({ guard });
    await expect(
      client.callTool({ name: `echo${NS}echo`, arguments: { text: 'leak sk_live_1234567890abcdef now' } }),
    ).rejects.toThrow(/Stripe key/);
    const last = recorded.at(-1)!;
    expect(last).toMatchObject({ blocked: 'secret', ok: false });
    expect(JSON.stringify(last)).not.toContain('sk_live_1234567890abcdef');
    await client.close();
  });

  it('redacts a vault value that comes back in a result', async () => {
    // The echo tool returns its input, so feed it something that becomes the
    // secret only on the way back: the guard checks arguments first, so use a
    // guard that knows a value the arguments do not contain verbatim.
    const g = createSecretGuard(() => [{ label: 'token', value: 'hello-secret-world' }]);
    const split: SecretGuard = { findInArgs: () => undefined, redact: g.redact };
    const client = await connect({ guard: split });
    const res = (await client.callTool({ name: `echo${NS}echo`, arguments: { text: 'say hello-secret-world' } })) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toBe(`say ${REDACTED}`);
    await client.close();
  });
});
