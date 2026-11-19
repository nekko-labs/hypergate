import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentInstructions } from './instructions.js';

/** A throwaway home with a backup dir beside it. Never the real home. */
const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'hypergate-instructions-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const backups = join(root, 'backups');
  return { home, backups, ai: new AgentInstructions(home, backups, {}) };
};

const keyFor = () => 'claude-code';

describe('AgentInstructions', () => {
  it('reports every harness, detected only where its config dir exists', () => {
    const { home, ai } = sandbox();
    mkdirSync(join(home, '.codex'));
    const st = ai.status(keyFor);
    expect(st.blockVersion).toBe(1);
    expect(st.harnesses.find((h) => h.id === 'codex')?.detected).toBe(true);
    expect(st.harnesses.find((h) => h.id === 'claude-code')?.detected).toBe(false);
    expect(st.harnesses.every((h) => !h.installed)).toBe(true);
    expect(st.skipped.some((s) => s.name === 'Cursor')).toBe(true);
  });

  it('install all writes only detected harnesses, creates files, and is idempotent', () => {
    const { home, ai } = sandbox();
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.gemini'));
    const first = ai.install('all', keyFor);
    expect(first.map((r) => r.id).sort()).toEqual(['claude-code', 'gemini']);
    expect(first.every((r) => r.changed && !r.backup)).toBe(true);
    const text = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(text).toContain('hypergate run --agent claude-code');
    expect(ai.install('all', keyFor).every((r) => !r.changed)).toBe(true);
    expect(ai.status(keyFor).harnesses.find((h) => h.id === 'claude-code')).toMatchObject({ installed: true, current: true });
  });

  it('backs up an existing file once, before the first write, and preserves its text', () => {
    const { home, backups, ai } = sandbox();
    const dir = join(home, '.claude');
    mkdirSync(dir);
    writeFileSync(join(dir, 'CLAUDE.md'), '# Mine\n');
    const [r] = ai.install('claude-code', keyFor);
    expect(r.backup).toBeDefined();
    expect(readFileSync(r.backup!, 'utf8')).toBe('# Mine\n');
    // A key change rewrites the block, but the first backup stays the only one.
    ai.install('claude-code', () => 'claude-code-2');
    expect(readdirSync(backups)).toHaveLength(1);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').startsWith('# Mine\n\n<!-- hypergate:begin v1 -->')).toBe(true);
  });

  it('remove restores a user file and deletes a file that held only the block', () => {
    const { home, ai } = sandbox();
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
    ai.install('all', keyFor);
    const out = ai.remove('all');
    expect(out.map((r) => r.id).sort()).toEqual(['claude-code', 'codex']);
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# Mine\n');
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(false);
  });

  it('honours a forwarded CLAUDE_CONFIG_DIR under home and ignores other keys', () => {
    const { home, ai } = sandbox();
    const alt = join(home, '.claude-work');
    mkdirSync(alt);
    const [r] = ai.install('claude-code', keyFor, { CLAUDE_CONFIG_DIR: alt, PATH: '/evil' });
    expect(r.path).toBe(join(alt, 'CLAUDE.md'));
    const outside = mkdtempSync(join(tmpdir(), 'hypergate-outside-'));
    const [r2] = ai.install('claude-code', keyFor, { CLAUDE_CONFIG_DIR: outside });
    expect(r2.path).toBe(join(home, '.claude', 'CLAUDE.md'));
  });

  it('writes OpenCode and Claude Code once when they share a file', () => {
    const { home, ai } = sandbox();
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
    const out = ai.install('all', keyFor);
    expect(out.map((r) => r.id)).toEqual(['claude-code']);
    expect(existsSync(join(home, '.config', 'opencode', 'AGENTS.md'))).toBe(false);
  });

  it('reports a damaged file instead of writing to it', () => {
    const { home, ai } = sandbox();
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'GEMINI.md'), '<!-- hypergate:begin v1 -->\nhalf');
    const [r] = ai.install('gemini', keyFor);
    expect(r.error).toMatch(/no end marker/);
    expect(ai.status(keyFor).harnesses.find((h) => h.id === 'gemini')?.damaged).toBe(true);
  });

  it('rejects an unknown harness id', () => {
    expect(() => sandbox().ai.install('nope', keyFor)).toThrow(/unknown harness/);
  });
});
