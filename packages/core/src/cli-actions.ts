import type { CliCatalogEntry, CliInstallOption, CliManagerInfo } from '@hypergate/shared';
import { CURATED_SCRIPT_COMMANDS } from './clis.js';

/**
 * Turning catalog data into runnable lifecycle commands: which package managers
 * exist, which install routes the daemon may execute, and the uninstall/repair
 * commands each manager makes mechanical. Pure data-in data-out; the daemon
 * does the PATH probes and the spawning.
 *
 * The safety model matches the shell's `parse_curated_install` (commands.rs):
 * a command is only executable when it is a plain argv list, free of shell
 * metacharacters and URLs, whose program is a known package-manager launcher.
 *
 * Vendor install scripts are the one deliberate exception, and they are held to
 * three independent gates instead of one (`parseCuratedScript`): the string must
 * be byte-identical to a curated route, match a narrow grammar, and fetch from
 * an allowlisted vendor host. Download pages remain copy-only, since there is
 * nothing to run.
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

/**
 * Hosts a curated install script may fetch from. One short list, so widening the
 * blast radius of the script runner is a one-line diff someone has to review
 * rather than a regex that quietly grows. Matched exactly, never as a suffix.
 */
const SCRIPT_HOSTS = new Set(['claude.ai', 'bun.sh', 'deno.land', 'astral.sh', 'fly.io']);

/** `curl -fsSL <url> | bash`, optionally with the vendor's own `-s <channel>` argument. */
const POSIX_SCRIPT = /^(curl|wget)((?: -[A-Za-z0-9-]+)+) (https:\/\/[^\s"|]+) \| (sh|bash)(?: -s [A-Za-z0-9._-]+)?$/;

/** `powershell [-ExecutionPolicy ByPass] -c "irm <url> | iex"`, and the `iwr … -useb` variant. */
const PS_SCRIPT =
  /^powershell(?: -ExecutionPolicy ByPass)? -c "(?:irm (https:\/\/[^\s"|]+)|iwr (https:\/\/[^\s"|]+) -useb) \| iex"$/;

/** What a validated vendor install script needs in order to run. */
export interface CuratedScript {
  /** Which interpreter runs it. */
  shell: 'posix' | 'powershell';
  /** The executable that must be on PATH for the route to work at all. */
  requires: string;
  /** The https URL the script body comes from. */
  url: string;
}

/**
 * The *shape* half of the script check: does this command match one of the two
 * forms vendors document, fetching over https from a host on the allowlist?
 *
 * Exported separately from `parseCuratedScript` so the grammar can be tested
 * against hostile input directly, without a curated command to hide behind.
 * On its own this is NOT authority to run anything; `parseCuratedScript` is.
 */
export function parseScriptShape(command: string): CuratedScript | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const posix = POSIX_SCRIPT.exec(trimmed);
  const ps = posix ? null : PS_SCRIPT.exec(trimmed);
  const raw = posix ? posix[3] : (ps?.[1] ?? ps?.[2]);
  if (!raw) return null;
  let host: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    host = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!SCRIPT_HOSTS.has(host)) return null;
  return posix
    ? { shell: 'posix', requires: posix[1], url: raw }
    : { shell: 'powershell', requires: 'powershell', url: raw };
}

/**
 * A vendor install script the daemon may run, or null.
 *
 * Three gates, all of which must pass. The command must be **byte-identical to a
 * curated route** (`CURATED_SCRIPT_COMMANDS`), so nothing arriving from a
 * registry lookup, an agent's request body, or a search box can reach a shell no
 * matter how faithfully it imitates the grammar; it must match that grammar; and
 * it must fetch from an allowlisted vendor host over https.
 *
 * This is the one place in the product where a shell is involved at all, which
 * is why the allowlist is the outer gate rather than the grammar.
 */
export function parseCuratedScript(command: string): CuratedScript | null {
  if (!CURATED_SCRIPT_COMMANDS.has(command.trim())) return null;
  return parseScriptShape(command);
}

/** Package managers that install into the system, ahead of any language-scoped one. */
const SYSTEM_MANAGERS = new Set(['brew', 'winget', 'scoop', 'choco']);

/**
 * Where a route sorts. Lower is better, and the two questions are *what kind of
 * route is it* and *can this machine run it*:
 *
 * | rank | route                                    |
 * |------|------------------------------------------|
 * | 0    | system package manager, present          |
 * | 1    | vendor install script, fetcher present    |
 * | 2    | language package manager, present         |
 * | 3–5  | the same three, launcher missing          |
 * | 6    | not runnable (a download page)            |
 *
 * A system manager wins because it is the route that also knows how to upgrade
 * and remove the tool afterwards; the vendor's own script beats npm because it
 * installs what the vendor ships rather than a republished copy. An unprobed
 * route counts as present: the daemon is the judge of what exists here, and a
 * failed probe must never quietly demote a route the user can in fact run.
 */
export function rankInstall(option: CliInstallOption): number {
  const kind =
    option.runner === 'script' ? 1 : option.runner === 'argv' ? (SYSTEM_MANAGERS.has(option.manager ?? '') ? 0 : 2) : undefined;
  if (kind === undefined) return 6;
  return kind + (option.available === false ? 3 : 0);
}

/** Whether the daemon has any way to run this route itself. */
export const isRunnable = (option: CliInstallOption): boolean =>
  option.runner === 'script' || !!parseCuratedCommand(option.command);

/** Routes best-first for the machine that asked. Stable, so ties keep catalog order. */
export const orderInstalls = (installs: CliInstallOption[]): CliInstallOption[] =>
  installs
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rankInstall(a.option) - rankInstall(b.option) || a.index - b.index)
    .map((x) => x.option);

/** How a route runs, and what it needs on PATH to do so. */
function routeRunner(option: CliInstallOption): Pick<CliInstallOption, 'manager' | 'runner' | 'requires'> {
  const script = parseCuratedScript(option.command);
  if (script) return { manager: 'script', runner: 'script', requires: script.requires };
  const argv = parseCuratedCommand(option.command);
  if (argv) return { manager: managerOf(option), runner: 'argv', requires: argv[0] };
  return { manager: managerOf(option) };
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
    case 'brew': {
      // `raw`, not `pkg`: a tap path like supabase/tap/supabase has no version to strip.
      // `--cask` rides along so the reverse command names the cask that was
      // installed rather than a formula that happens to share its name.
      const cask = argv.includes('--cask') ? '--cask ' : '';
      return { uninstall: `brew uninstall ${cask}${raw}`, repair: `brew reinstall ${cask}${raw}` };
    }
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
 * Annotate an entry's install routes with manager ids, how each one runs, and
 * its lifecycle commands; extend an npm route into its pnpm/yarn/bun
 * equivalents; and leave them **ranked best-first** (see `rankInstall`), so
 * every surface that reads `installs` gets the same preference without
 * re-deriving it. Platform-filtered routes are assumed already filtered
 * (`cliCatalogEntry` does that); the derived npm-family routes apply
 * everywhere. Idempotent.
 */
export function enrichCliInstalls(entry: CliCatalogEntry): CliCatalogEntry {
  if (!entry.installs?.length) return entry;
  const annotated: CliInstallOption[] = entry.installs.map((option) => ({
    ...option,
    ...routeRunner(option),
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
      annotated.push({ ...option, ...routeRunner(option), ...lifecycleFor(option) });
    }
  }
  return { ...entry, installs: orderInstalls(annotated) };
}

/** Pick the route a job should run: the requested manager's, else the best runnable one. */
export function chooseInstall(entry: CliCatalogEntry, manager?: string): CliInstallOption | undefined {
  const runnable = (entry.installs ?? []).filter(isRunnable);
  if (manager) return runnable.find((o) => o.manager === manager);
  // `installs` is already ranked, so the first route whose launcher this machine
  // actually has is the answer. The fallback keeps a machine that has none of
  // them pointed at a real command, whose own error says what is missing.
  return runnable.find((o) => o.available !== false) ?? runnable[0];
}
