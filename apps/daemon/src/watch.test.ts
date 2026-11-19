import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watcher, fsDeps, userToolDirs, type WatchDeps } from './watch.js';

const OPENAI = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

const setup = (onPath: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'hypergate-watch-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  mkdirSync(home, { recursive: true });
  const bin = join(home, '.local', 'bin');
  let clock = Date.parse('2026-11-19T10:00:00Z');
  const deps: WatchDeps = {
    dataDir: data,
    ambient: { home, platform: 'linux', env: {} },
    ...fsDeps(),
    catalog: [{ id: 'gh', name: 'GitHub CLI', command: 'gh' }],
    resolve: (c) => onPath[c],
    toolDirs: [{ dir: bin, source: 'user-bin', layout: 'bin' }],
    now: () => new Date((clock += 1000)),
  };
  return { home, data, bin, deps, onPath };
};

describe('Watcher', () => {
  it('the first pass is a silent baseline; later additions raise events', () => {
    const { home, deps, bin, onPath } = setup();
    writeFileSync(join(home, '.zshrc'), `export OPENAI_API_KEY=${OPENAI}\n`);
    const w = new Watcher(deps);
    expect(w.pass().events).toEqual([]);

    writeFileSync(join(home, '.bashrc'), 'export OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef\n');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'newtool'), '');
    onPath.gh = '/usr/bin/gh';
    const { events, hits } = w.pass();
    expect(events.map((e) => [e.kind, e.tool]).sort()).toEqual([
      ['ambient-new', 'Shell startup file'],
      ['cli-new', 'GitHub CLI'],
      ['cli-new', 'newtool'],
    ]);
    expect(hits).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('sk-or-v1');
  });

  it('a restart does not re-announce, and a changed value is ambient-changed', () => {
    const { home, deps } = setup();
    writeFileSync(join(home, '.zshrc'), `export OPENAI_API_KEY=${OPENAI}\n`);
    new Watcher(deps).pass();
    const again = new Watcher(deps);
    expect(again.pass().events).toEqual([]);
    writeFileSync(join(home, '.zshrc'), 'export OPENAI_API_KEY=sk-proj-ZZZZZZZZZZZZZZZZZZZZZZZZ\n');
    expect(again.pass().events.map((e) => e.kind)).toEqual(['ambient-changed']);
    expect(again.events().events).toHaveLength(1);
  });

  it('a removed login that comes back counts as new', () => {
    const { home, deps } = setup();
    const w = new Watcher(deps);
    writeFileSync(join(home, '.zshrc'), `export OPENAI_API_KEY=${OPENAI}\n`);
    w.pass();
    writeFileSync(join(home, '.zshrc'), '\n');
    expect(w.pass().events).toEqual([]);
    writeFileSync(join(home, '.zshrc'), `export OPENAI_API_KEY=${OPENAI}\n`);
    expect(w.pass().events.map((e) => e.kind)).toEqual(['ambient-new']);
  });

  it('npm global packages, including scoped ones, are new CLIs', () => {
    const { deps } = setup();
    const prefix = join(deps.dataDir, '..', 'npm');
    const nm = join(prefix, 'lib', 'node_modules');
    mkdirSync(join(nm, 'npm'), { recursive: true });
    deps.toolDirs = userToolDirs(deps.ambient.home, 'linux', {}, prefix).filter((d) => d.source === 'npm-global');
    const w = new Watcher(deps);
    w.pass();
    mkdirSync(join(nm, '@acme', 'cli'), { recursive: true });
    mkdirSync(join(nm, 'vercel'), { recursive: true });
    expect(w.pass().events.map((e) => e.tool).sort()).toEqual(['@acme/cli', 'vercel']);
  });
});
