import { describe, it, expect } from 'vitest';
import {
  agentNameFromKey,
  agentSlug,
  isServerAllowed,
  matchAgents,
  resolveAgent,
  setServerAllowed,
} from './agents.js';

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

describe('agentSlug', () => {
  it('is the id stem the daemon mints from a display name', () => {
    expect(agentSlug('Claude Code')).toBe('claude-code');
    expect(agentSlug('  VS Code  ')).toBe('vs-code');
    expect(agentSlug('.mcp.json')).toBe('mcp-json');
  });

  it('never returns an empty id', () => {
    expect(agentSlug('!!!')).toBe('agent');
    expect(agentSlug('')).toBe('agent');
  });

  it('is bounded, so an id stays a manageable length', () => {
    expect(agentSlug('x'.repeat(100))).toHaveLength(32);
  });
});

describe('agentNameFromKey', () => {
  it('turns a bare key into the name a person would have typed', () => {
    expect(agentNameFromKey('claude-code')).toBe('Claude Code');
    expect(agentNameFromKey('cursor')).toBe('Cursor');
  });

  it('survives punctuation and junk', () => {
    expect(agentNameFromKey('gemini_cli')).toBe('Gemini Cli');
    expect(agentNameFromKey('???')).toBe('Agent');
  });
});

describe('matchAgents', () => {
  const agents = [
    { id: 'claude-code-a8ce', name: 'Claude Code' },
    { id: 'cursor-579a', name: 'Cursor' },
  ];

  it('finds an agent by its exact id', () => {
    expect(matchAgents(agents, 'cursor-579a')).toEqual([agents[1]]);
  });

  it('finds an agent by display name, whatever the casing or punctuation', () => {
    expect(matchAgents(agents, 'Claude Code')).toEqual([agents[0]]);
    expect(matchAgents(agents, 'claude code')).toEqual([agents[0]]);
    expect(matchAgents(agents, 'claude-code')).toEqual([agents[0]]);
  });

  it('finds the replacement for an agent that was deleted and re-created', () => {
    // The whole point: a client config written against `claude-code-a8ce` keeps
    // working after that agent is gone and `claude-code-91f2` stands in its place.
    const rebuilt = [{ id: 'claude-code-91f2', name: 'Claude Code' }];
    expect(matchAgents(rebuilt, 'claude-code-a8ce')).toEqual(rebuilt);
  });

  it('prefers an exact id over a name that would also match', () => {
    const both = [
      { id: 'claude-code-a8ce', name: 'Something Else' },
      { id: 'other-1111', name: 'claude code a8ce' },
    ];
    expect(matchAgents(both, 'claude-code-a8ce')).toEqual([both[0]]);
  });

  it('reports every candidate when a key is ambiguous', () => {
    const twins = [
      { id: 'claude-code-a8ce', name: 'Claude Code' },
      { id: 'claude-code-91f2', name: 'Claude Code' },
    ];
    expect(matchAgents(twins, 'claude-code')).toHaveLength(2);
  });

  it('is empty for an unknown or blank key', () => {
    expect(matchAgents(agents, 'windsurf')).toEqual([]);
    expect(matchAgents(agents, '   ')).toEqual([]);
  });
});

describe('resolveAgent', () => {
  const twins = [
    { id: 'claude-code-a8ce', name: 'Claude Code' },
    { id: 'claude-code-91f2', name: 'Claude Code' },
  ];

  it('answers when exactly one agent matches', () => {
    expect(resolveAgent(twins, 'claude-code-91f2')?.id).toBe('claude-code-91f2');
  });

  it('refuses to guess between two matches, because the answer is a credential', () => {
    expect(resolveAgent(twins, 'claude-code')).toBeUndefined();
  });
});
