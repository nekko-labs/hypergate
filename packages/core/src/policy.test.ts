import { describe, it, expect } from 'vitest';
import { isDestructive, isReadOnly, toolAllowed, updatePolicy } from './policy.js';
import { createSecretGuard, REDACTED } from './guard.js';

describe('toolAllowed', () => {
  it('allows everything when there is no policy (the pre-existing behaviour)', () => {
    expect(toolAllowed(undefined, 'gh', 'delete_repo', undefined).ok).toBe(true);
  });

  it('refuses a blocked tool by its namespaced name only', () => {
    const p = { blocked: ['gh__delete_repo'] };
    expect(toolAllowed(p, 'gh', 'delete_repo', { readOnlyHint: true }).ok).toBe(false);
    expect(toolAllowed(p, 'gh', 'list_repos', undefined).ok).toBe(true);
    expect(toolAllowed(p, 'other', 'delete_repo', undefined).ok).toBe(true);
  });

  it('read-only admits only tools the server declares read-only', () => {
    const p = { readOnly: true };
    expect(toolAllowed(p, 'gh', 'list', { readOnlyHint: true }).ok).toBe(true);
    expect(toolAllowed(p, 'gh', 'merge', { readOnlyHint: false }).ok).toBe(false);
    // MCP's default: an unannotated tool is not read-only.
    expect(toolAllowed(p, 'gh', 'mystery', undefined).ok).toBe(false);
    const d = toolAllowed(p, 'gh', 'mystery', {});
    expect(!d.ok && d.reason).toMatch(/not declared read-only/);
  });

  it('classifies hints conservatively', () => {
    expect(isReadOnly({ readOnlyHint: true })).toBe(true);
    expect(isReadOnly(undefined)).toBe(false);
    expect(isDestructive(undefined)).toBe(true);
    expect(isDestructive({ readOnlyHint: true, destructiveHint: true })).toBe(false);
  });
});

describe('updatePolicy', () => {
  it('blocks and unblocks one tool, and collapses back to undefined', () => {
    let p = updatePolicy(undefined, { tool: 'gh__merge', allowed: false });
    expect(p).toEqual({ blocked: ['gh__merge'] });
    p = updatePolicy(p, { readOnly: true });
    expect(p).toEqual({ blocked: ['gh__merge'], readOnly: true });
    p = updatePolicy(p, { tool: 'gh__merge', allowed: true });
    expect(p).toEqual({ readOnly: true });
    expect(updatePolicy(p, { readOnly: false })).toBeUndefined();
  });
});

describe('createSecretGuard', () => {
  const guard = createSecretGuard(() => [
    { label: 'GitHub token', value: 'ghp_abcdefghijklmnop' },
    { label: 'tiny', value: 'abc' },
  ]);

  it('finds a vault value anywhere in the arguments, keys included', () => {
    expect(guard.findInArgs({ body: 'see ghp_abcdefghijklmnop please' })).toBe('GitHub token');
    expect(guard.findInArgs({ nested: [{ deep: 'x ghp_abcdefghijklmnop' }] })).toBe('GitHub token');
    expect(guard.findInArgs({ ghp_abcdefghijklmnop: 1 })).toBe('GitHub token');
    expect(guard.findInArgs({ body: 'nothing here' })).toBeUndefined();
  });

  it('ignores values too short to be meaningful', () => {
    expect(guard.findInArgs({ body: 'abc abc' })).toBeUndefined();
  });

  it('redacts vault values from a result without changing its shape', () => {
    const res = { content: [{ type: 'text', text: 'token=ghp_abcdefghijklmnop end' }], isError: false };
    const out = guard.redact(res);
    expect(out).toEqual({ content: [{ type: 'text', text: `token=${REDACTED} end` }], isError: false });
    expect(res.content[0]!.text).toContain('ghp_'); // input untouched
  });

  it('is a no-op with an empty vault', () => {
    const empty = createSecretGuard(() => []);
    const v = { a: 'ghp_abcdefghijklmnop' };
    expect(empty.findInArgs(v)).toBeUndefined();
    expect(empty.redact(v)).toBe(v);
  });
});
