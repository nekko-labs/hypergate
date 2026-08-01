import { describe, it, expect } from 'vitest';
import { isServerAllowed, setServerAllowed } from './agents.js';

const ALL = ['echo', 'github', 'postgres'];

describe('isServerAllowed', () => {
  it("'*' allows anything, including a server that does not exist yet", () => {
    expect(isServerAllowed('*', 'echo')).toBe(true);
    expect(isServerAllowed('*', 'added-tomorrow')).toBe(true);
  });

  it('an explicit list allows only what it names', () => {
    expect(isServerAllowed(['echo'], 'echo')).toBe(true);
    expect(isServerAllowed(['echo'], 'github')).toBe(false);
    expect(isServerAllowed([], 'echo')).toBe(false);
  });
});

describe('setServerAllowed', () => {
  it('adds a server to an explicit list', () => {
    expect(setServerAllowed(['echo'], 'github', true, ALL)).toEqual(['echo', 'github']);
  });

  it('is idempotent when the server is already allowed', () => {
    expect(setServerAllowed(['echo'], 'echo', true, ALL)).toEqual(['echo']);
    expect(setServerAllowed('*', 'echo', true, ALL)).toBe('*');
  });

  it('removes a server from an explicit list', () => {
    expect(setServerAllowed(['echo', 'github'], 'echo', false, ALL)).toEqual(['github']);
  });

  it('disabling one server materialises a wildcard into the rest', () => {
    // '*' cannot express "all but this one", so it becomes the servers that
    // exist now, minus the one turned off.
    expect(setServerAllowed('*', 'github', false, ALL)).toEqual(['echo', 'postgres']);
  });

  it('never widens an explicit list back into a wildcard', () => {
    // Allowing the last missing server keeps the list explicit: '*' would also
    // grant every server added later, which the user never asked for.
    expect(setServerAllowed(['echo', 'github'], 'postgres', true, ALL)).toEqual(['echo', 'github', 'postgres']);
  });

  it('leaves an agent blocked rather than empty-meaning-all', () => {
    expect(setServerAllowed(['echo'], 'echo', false, ALL)).toEqual([]);
  });

  it('keeps ids the roster no longer has, so unrelated entries are not pruned', () => {
    // Flipping one permission must not quietly rewrite the others: a stale id
    // (server removed, config hand-edited) is the owner's business, not ours.
    expect(setServerAllowed(['echo', 'gone'], 'github', true, ALL)).toEqual(['echo', 'gone', 'github']);
  });

  it('does not mutate the scope it was given', () => {
    const scope = ['echo'];
    setServerAllowed(scope, 'github', true, ALL);
    expect(scope).toEqual(['echo']);
  });
});
