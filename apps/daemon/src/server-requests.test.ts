import { describe, expect, it } from 'vitest';
import { ServerInstallRequestStore } from './server-requests.ts';
import type { RegistryEntry } from '@hypergate/shared';

const entry = (id = 'com-microsoft-azure', version = '2.0.2'): RegistryEntry => ({
  id,
  name: 'Azure',
  description: '',
  runtime: 'process',
  command: 'npx',
  args: ['-y', `@azure/mcp@${version}`, 'server', 'start'],
});

const ask = (store: ServerInstallRequestStore, agentId = 'a1', id = 'com-microsoft-azure', reason?: string, version = '2.0.2') =>
  store.file({
    query: 'com.microsoft/azure',
    serverName: 'com.microsoft/azure',
    entry: entry(id, version),
    version,
    summary: `npx -y @azure/mcp@${version} server start`,
    outstanding: ['Install Azure CLI'],
    agentId,
    agentName: `Agent ${agentId}`,
    reason,
  });

describe('ServerInstallRequestStore', () => {
  it('dedupes a retry loop into one row with an attempt count', () => {
    const store = new ServerInstallRequestStore();
    const first = ask(store, 'a1', 'com-microsoft-azure', 'the user asked about their Azure resources');
    const second = ask(store);
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);
    expect(second.reason).toBe('the user asked about their Azure resources');
    expect(store.count()).toBe(1);
  });

  it('a retry refreshes what would actually be added', () => {
    // An agent may be re-asking because a newer release has shipped; the user
    // should approve the current answer, not the one from an hour ago.
    const store = new ServerInstallRequestStore();
    ask(store);
    const second = ask(store, 'a1', 'com-microsoft-azure', undefined, '2.1.0');
    expect(second.version).toBe('2.1.0');
    expect(second.entry.args).toContain('@azure/mcp@2.1.0');
  });

  it('distinct agents and servers are distinct rows, oldest first', () => {
    const store = new ServerInstallRequestStore();
    ask(store, 'a1', 'com-microsoft-azure');
    ask(store, 'a2', 'com-microsoft-azure');
    ask(store, 'a1', 'linear');
    expect(store.list().map((r) => `${r.agentId}:${r.serverId}`)).toEqual(['a1:com-microsoft-azure', 'a2:com-microsoft-azure', 'a1:linear']);
  });

  it('expires rows past the TTL', () => {
    let now = Date.parse('2026-08-25T00:00:00Z');
    const store = new ServerInstallRequestStore(() => now);
    ask(store);
    now += 61 * 60 * 1000;
    expect(store.count()).toBe(0);
  });

  it('caps the queue, evicting the oldest', () => {
    let now = Date.parse('2026-08-25T00:00:00Z');
    const store = new ServerInstallRequestStore(() => now);
    for (let i = 0; i < 55; i++) {
      now += 1000;
      ask(store, `a${i}`);
    }
    expect(store.count()).toBe(50);
    expect(store.list()[0].agentId).toBe('a5');
  });

  it('resolving removes the row and says what it was', () => {
    const store = new ServerInstallRequestStore();
    const row = ask(store);
    expect(store.resolve(row.id)?.serverId).toBe('com-microsoft-azure');
    expect(store.count()).toBe(0);
    expect(store.resolve(row.id)).toBeUndefined();
  });

  it('forgets every request from a deleted agent', () => {
    const store = new ServerInstallRequestStore();
    ask(store, 'a1', 'com-microsoft-azure');
    ask(store, 'a1', 'linear');
    ask(store, 'a2', 'linear');
    store.forgetAgent('a1');
    expect(store.list().map((r) => r.agentId)).toEqual(['a2']);
  });

  it('hands out copies, so a caller cannot mutate the queue', () => {
    const store = new ServerInstallRequestStore();
    const row = ask(store);
    row.reason = 'tampered';
    expect(store.get(row.id)?.reason).not.toBe('tampered');
  });
});
