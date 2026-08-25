import { describe, expect, it } from 'vitest';
import { CliInstallRequestStore } from './cli-requests.ts';

const ask = (store: CliInstallRequestStore, agentId = 'a1', cliId = 'flyctl', reason?: string) =>
  store.file({ cliId, cliName: cliId, agentId, agentName: `Agent ${agentId}`, reason });

describe('CliInstallRequestStore', () => {
  it('dedupes a retry loop into one row with an attempt count', () => {
    const store = new CliInstallRequestStore();
    const first = ask(store, 'a1', 'flyctl', 'deploying the app');
    const second = ask(store, 'a1', 'flyctl');
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);
    expect(second.reason).toBe('deploying the app'); // never overwritten with nothing
    expect(store.count()).toBe(1);
  });

  it('a later, better reason replaces the earlier one', () => {
    const store = new CliInstallRequestStore();
    ask(store, 'a1', 'flyctl');
    const second = ask(store, 'a1', 'flyctl', 'fly deploy needs it');
    expect(second.reason).toBe('fly deploy needs it');
  });

  it('distinct agents and tools are distinct rows, oldest first', () => {
    const store = new CliInstallRequestStore();
    ask(store, 'a1', 'flyctl');
    ask(store, 'a2', 'flyctl');
    ask(store, 'a1', 'gh');
    expect(store.list().map((r) => `${r.agentId}:${r.cliId}`)).toEqual(['a1:flyctl', 'a2:flyctl', 'a1:gh']);
  });

  it('expires rows past the TTL', () => {
    let now = Date.parse('2026-08-25T00:00:00Z');
    const store = new CliInstallRequestStore(() => now);
    ask(store);
    now += 61 * 60 * 1000;
    expect(store.count()).toBe(0);
  });

  it('caps pending rows, evicting the oldest', () => {
    let now = Date.parse('2026-08-25T00:00:00Z');
    const store = new CliInstallRequestStore(() => now);
    for (let i = 0; i < 55; i += 1) {
      now += 1000;
      ask(store, 'a1', `tool-${i}`);
    }
    expect(store.count()).toBe(50);
    expect(store.list()[0].cliId).toBe('tool-5');
  });

  it('resolve removes exactly one row and returns it; a second resolve is a miss', () => {
    const store = new CliInstallRequestStore();
    const row = ask(store);
    expect(store.resolve(row.id)?.cliId).toBe('flyctl');
    expect(store.resolve(row.id)).toBeUndefined();
    expect(store.count()).toBe(0);
  });

  it('forgets a deleted agent’s requests', () => {
    const store = new CliInstallRequestStore();
    ask(store, 'a1', 'flyctl');
    ask(store, 'a2', 'gh');
    store.forgetAgent('a1');
    expect(store.list().map((r) => r.agentId)).toEqual(['a2']);
  });

  it('carries channel and package for looked-up tools', () => {
    const store = new CliInstallRequestStore();
    const row = store.file({
      cliId: 'ripgrep',
      cliName: 'ripgrep',
      channel: 'brew',
      package: 'ripgrep',
      agentId: 'a1',
      agentName: 'Agent',
    });
    expect(row.channel).toBe('brew');
    expect(row.package).toBe('ripgrep');
  });
});
