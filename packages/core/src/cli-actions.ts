import type { CliCatalogEntry, CliInstallOption, CliManagerInfo } from '@hypergate/shared';

/**
 * Turning catalog data into runnable lifecycle commands: which package managers
 * exist, which install routes the daemon may execute, and the uninstall/repair
 * commands each manager makes mechanical. Pure data-in data-out; the daemon
 * does the PATH probes and the spawning.
 *
 * The safety model matches the shell's `parse_curated_install` (commands.rs):
 * a command is only executable when it is a plain argv list, free of shell
 * metacharacters and URLs, whose program is a known package-manager launcher.
 * Everything else (vendor curl|sh scripts, download pages) stays copy-only.
 */

/** The package managers Hypergate can drive, with the command each is probed by. */
export const CLI_MANAGERS: ReadonlyArray<Omit<CliManagerInfo, 'found'> & { platforms?: string[] }> = [
  { id: 'npm', label: 'npm', command: 'npm' },
  { id: 'pnpm', label: 'pnpm', command: 'pnpm' },
  { id: 'yarn', label: 'yarn', command: 'yarn' },
  { id: 'bun', label: 'bun', command: 'bun' },
  { id: 'brew', label: 'Homebrew', command: 'brew', platforms: ['darwin', 'linux'] },
  { id: 'winget', label: 'winget', command: 'winget', platforms: ['win32'] },
  { id: 'scoop', label: 'Scoop', command: 'scoop', platforms: ['win32'] },
  { id: 'choco', label: 'Chocolatey', command: 'choco', platforms: ['win32'] },
  { id: 'pipx', label: 'pipx', command: 'pipx' },
  { id: 'uv', label: 'uv', command: 'uv' },
  { id: 'cargo', label: 'cargo', command: 'cargo' },
];

/** Launchers the daemon will execute. Mirrors the shell's allowlist, plus `uv`. */
const LAUNCHERS = ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'brew', 'pipx', 'pip', 'winget', 'scoop', 'choco', 'cargo', 'uv'];

const META = /[|&;<>$`(){}'"\\\r\n]/;

/**
 * A curated command as an argv list, or null when it must not be executed.
 * Port of the shell's `parse_curated_install`: same rejections, same allowlist
 * shape, so the two runners cannot disagree about what is runnable.
 */
export function parseCuratedCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || META.test(trimmed)) return null;
  const argv = trimmed.split(/\s+/);
  if (argv.some((word) => /^https?:\/\//i.test(word))) return null;
  const program = argv[0];
  if (!LAUNCHERS.includes(program)) return null;
  if (!/^[a-zA-Z0-9_.:/-]+$/.test(program)) return null;
  return argv;
}

/** The canonical manager id for an install option, from its command or label. */
export function managerOf(option: CliInstallOption): string | undefined {
  if (option.manager) return option.manager;
  const program = option.command.trim().split(/\s+/)[0]?.toLowerCase();
  if (LAUNCHERS.includes(program)) return program;
  const label = option.label.toLowerCase();
  const byLabel = CLI_MANAGERS.find((m) => m.label.toLowerCase() === label || m.id === label);
  return byLabel?.id;
}

/** The bare package/formula the command installs, for building the reverse command. */
const packageOf = (argv: string[]): string | undefined => {
  const args = argv.slice(1).filter((a) => !a.startsWith('-'));
  // npm install -g <pkg> · brew install <formula> · winget install <id> ·
  // scoop install <name> · pipx install <pkg> · cargo install <crate> ·
  // uv tool install <pkg> · yarn global add <pkg> · pnpm add -g <pkg>
  const verbs = ['install', 'add', 'global', 'tool'];
  let i = 0;
  while (i < args.length && verbs.includes(args[i])) i += 1;
  return args[i];
};

const stripVersion = (pkg: string): string => {
  // `@scope/name@latest` → `@scope/name`; `name@1.2` → `name`.
  const at = pkg.lastIndexOf('@');
  return at > 0 ? pkg.slice(0, at) : pkg;
};

/**
 * The uninstall (and, where the manager has a better verb, repair) command for
 * one install route. Only mechanical inverses: a script or download route has
 * no derivable uninstall, so it gets none.
 */
export function lifecycleFor(option: CliInstallOption): Pick<CliInstallOption, 'uninstall' | 'repair'> {
  const argv = parseCuratedCommand(option.command);
  if (!argv) return {};
  const manager = managerOf(option);
  const raw = packageOf(argv);
  if (!manager || !raw) return {};
  const pkg = stripVersion(raw);
  switch (manager) {
    case 'npm':
      return { uninstall: `npm uninstall -g ${pkg}` };
    case 'pnpm':
      return { uninstall: `pnpm remove -g ${pkg}` };
    case 'yarn':
      return { uninstall: `yarn global remove ${pkg}` };
    case 'bun':
      return { uninstall: `bun remove -g ${pkg}` };
    case 'brew':
      // `raw`, not `pkg`: a tap path like supabase/tap/supabase has no version to strip.
      return { uninstall: `brew uninstall ${raw}`, repair: `brew reinstall ${raw}` };
    case 'winget':
      return { uninstall: `winget uninstall ${raw}` };
    case 'scoop':
      return { uninstall: `scoop uninstall ${raw}` };
    case 'choco':
      return { uninstall: `choco uninstall ${raw}` };
    case 'pipx':
      return { uninstall: `pipx uninstall ${pkg}`, repair: `pipx reinstall ${pkg}` };
    case 'cargo':
      return { uninstall: `cargo uninstall ${raw}` };
    case 'uv':
      return { uninstall: `uv tool uninstall ${pkg}` };
    default:
      return {};
  }
}

/**
 * The npm-family variants of an npm install route. Installing a published npm
 * package with pnpm, yarn, or bun is a mechanical fact of those managers, not a
 * vendor claim, so deriving these keeps the trust rule intact while giving a
 * machine without npm (or a user who prefers their own manager) a native route.
 */
const NPM_FAMILY: ReadonlyArray<{ manager: string; install: (pkg: string) => string }> = [
  { manager: 'pnpm', install: (pkg) => `pnpm add -g ${pkg}` },
  { manager: 'yarn', install: (pkg) => `yarn global add ${pkg}` },
  { manager: 'bun', install: (pkg) => `bun add -g ${pkg}` },
];

/**
 * Annotate an entry's install routes with manager ids and lifecycle commands,
 * and extend an npm route into its pnpm/yarn/bun equivalents. Platform-filtered
 * routes are assumed already filtered (`cliCatalogEntry` does that); the
 * derived npm-family routes apply everywhere. Idempotent.
 */
export function enrichCliInstalls(entry: CliCatalogEntry): CliCatalogEntry {
  if (!entry.installs?.length) return entry;
  const annotated: CliInstallOption[] = entry.installs.map((option) => ({
    ...option,
    manager: managerOf(option),
    ...lifecycleFor(option),
  }));
  const npmRoute = annotated.find((o) => o.manager === 'npm');
  const npmArgv = npmRoute && parseCuratedCommand(npmRoute.command);
  const npmPkg = npmArgv && packageOf(npmArgv);
  if (npmRoute && npmPkg) {
    const have = new Set(annotated.map((o) => o.manager));
    for (const family of NPM_FAMILY) {
      if (have.has(family.manager)) continue;
      const command = family.install(npmPkg);
      const option: CliInstallOption = { label: family.manager, command, manager: family.manager };
      annotated.push({ ...option, ...lifecycleFor(option) });
    }
  }
  return { ...entry, installs: annotated };
}

/** Pick the route a job should run: the requested manager's, else the first runnable one. */
export function chooseInstall(entry: CliCatalogEntry, manager?: string): CliInstallOption | undefined {
  const runnable = (entry.installs ?? []).filter((o) => parseCuratedCommand(o.command));
  if (manager) return runnable.find((o) => o.manager === manager);
  return runnable[0];
}
