import { describe, it, expect } from 'vitest';
import { CredentialRequestStore } from './requests.ts';

/** A clock the test drives, so TTL behaviour costs no wall time. */
const clock = (start = Date.UTC(2026, 7, 21, 12, 0, 0)) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

const ask = (store: CredentialRequestStore, over: Partial<Parameters<CredentialRequestStore['file']>[0]> = {}) =>
  store.file({
    credentialId: 'fly-token',
    credentialName: 'Fly.io API token',
    agentId: 'claude-code-a1b2',
    agentName: 'Claude Code',
    ...over,
  });

describe('filing a request', () => {
  it('records who asked for what', () => {
    const store = new CredentialRequestStore(clock().now);
    const r = ask(store, { reason: 'deploy the staging app' });
    expect(r.credentialId).toBe('fly-token');
    expect(r.agentName).toBe('Claude Code');
    expect(r.reason).toBe('deploy the staging app');
    expect(r.attempts).toBe(1);
    expect(store.count()).toBe(1);
  });

  it('collapses a retry loop into one row, counting the attempts', () => {
    // The failure this prevents: an agent retrying every second turns the
    // pending list into hundreds of identical rows and the badge into noise.
    const store = new CredentialRequestStore(clock().now);
    for (let i = 0; i < 20; i += 1) ask(store);
    expect(store.count()).toBe(1);
    expect(store.list()[0].attempts).toBe(20);
  });

  it('keeps the first ask time across retries', () => {
    // "Blocked for 5 minutes" is the useful fact; "last tried 1s ago" is not.
    const c = clock();
    const store = new CredentialRequestStore(c.now);
    const first = ask(store);
    c.advance(60_000);
    ask(store);
    expect(store.list()[0].askedAt).toBe(first.askedAt);
  });

  it('lets a later ask supply a reason, but never erase one', () => {
    const store = new CredentialRequestStore(clock().now);
    // A refusal files with no reason; the agent then asks properly with one.
    ask(store);
    expect(store.list()[0].reason).toBeUndefined();
    ask(store, { reason: 'deploy the staging app' });
    expect(store.list()[0].reason).toBe('deploy the staging app');
    ask(store);
    expect(store.list()[0].reason).toBe('deploy the staging app');
  });

  it('keeps different agents and different credentials apart', () => {
    const store = new CredentialRequestStore(clock().now);
    ask(store);
    ask(store, { agentId: 'cursor-9f9f', agentName: 'Cursor' });
    ask(store, { credentialId: 'stripe-sk', credentialName: 'Stripe secret key' });
    expect(store.count()).toBe(3);
  });

  it('trims whitespace-only reasons to nothing', () => {
    const store = new CredentialRequestStore(clock().now);
    expect(ask(store, { reason: '   ' }).reason).toBeUndefined();
  });
});

describe('expiry and the cap', () => {
  it('forgets a request once its TTL passes', () => {
    const c = clock();
    const store = new CredentialRequestStore(c.now);
    ask(store);
    c.advance(59 * 60 * 1000);
    expect(store.count()).toBe(1);
    c.advance(2 * 60 * 1000);
    expect(store.count()).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('caps the pending list, evicting the oldest', () => {
    // The rate here is agent-controlled, so this is the bound on what a
    // misbehaving one can cost in memory.
    const c = clock();
    const store = new CredentialRequestStore(c.now);
    for (let i = 0; i < 60; i += 1) {
      ask(store, { credentialId: `cred-${i}`, credentialName: `Credential ${i}` });
      c.advance(1000);
    }
    expect(store.count()).toBe(50);
    const ids = store.list().map((r) => r.credentialId);
    expect(ids).not.toContain('cred-0');
    expect(ids).toContain('cred-59');
  });

  it('lists oldest first, so the longest-blocked agent is answered first', () => {
    const c = clock();
    const store = new CredentialRequestStore(c.now);
    ask(store, { credentialId: 'first' });
    c.advance(5000);
    ask(store, { credentialId: 'second' });
    expect(store.list().map((r) => r.credentialId)).toEqual(['first', 'second']);
  });
});

describe('resolving and forgetting', () => {
  it('resolves by id and returns what it was', () => {
    const store = new CredentialRequestStore(clock().now);
    const r = ask(store);
    expect(store.resolve(r.id)?.credentialId).toBe('fly-token');
    expect(store.count()).toBe(0);
    // Answering the same request twice is a double-click, not an error.
    expect(store.resolve(r.id)).toBeUndefined();
  });

  it('finds a request by id before it is resolved', () => {
    const store = new CredentialRequestStore(clock().now);
    const r = ask(store);
    expect(store.get(r.id)?.agentName).toBe('Claude Code');
    expect(store.get('req-nope')).toBeUndefined();
  });

  it('drops every request for a deleted credential', () => {
    // Otherwise Approve would offer to grant access to an id that is gone.
    const store = new CredentialRequestStore(clock().now);
    ask(store);
    ask(store, { agentId: 'cursor-9f9f', agentName: 'Cursor' });
    ask(store, { credentialId: 'stripe-sk', credentialName: 'Stripe secret key' });
    store.forgetCredential('fly-token');
    expect(store.list().map((r) => r.credentialId)).toEqual(['stripe-sk']);
  });

  it('drops every request from a deleted agent', () => {
    // Its token was just revoked; granting it anything is meaningless.
    const store = new CredentialRequestStore(clock().now);
    ask(store);
    ask(store, { credentialId: 'stripe-sk', credentialName: 'Stripe secret key' });
    ask(store, { agentId: 'cursor-9f9f', agentName: 'Cursor' });
    store.forgetAgent('claude-code-a1b2');
    expect(store.list().map((r) => r.agentId)).toEqual(['cursor-9f9f']);
  });

  it('mints ids that do not collide after a resolve', () => {
    // The id is what the approve route looks up, so a reused one would let a
    // stale link answer a different agent's request.
    const store = new CredentialRequestStore(clock().now);
    const a = ask(store);
    store.resolve(a.id);
    const b = ask(store, { credentialId: 'stripe-sk', credentialName: 'Stripe secret key' });
    expect(b.id).not.toBe(a.id);
  });

  it('hands out copies, so a caller cannot mutate the store', () => {
    const store = new CredentialRequestStore(clock().now);
    ask(store);
    const listed = store.list()[0];
    listed.attempts = 999;
    expect(store.list()[0].attempts).toBe(1);
  });
});
