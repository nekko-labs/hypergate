/**
 * Credential lockdown: the pure policy behind `hypergate run` when
 * `Settings.credentialLockdown` is on.
 *
 * Lockdown changes what a credential *is* to an agent. Outside it, the vault
 * hands a value to whoever was granted it, and the caller decides what to do
 * with the string. Inside it, no value is handed to an agent at all: the only
 * way a key leaves the vault for a command is `hypergate run`, which puts it in
 * the environment of one named program, and this module decides which program
 * that may be.
 *
 * Three rules, in the order they are checked:
 *
 * 1. **No token printers.** A curated table of invocations whose whole job is to
 *    print (or mint and print) a secret, `gh auth token` being the obvious one.
 *    Running those through `hypergate run` would hand the key straight back to
 *    the caller, so they are refused outright.
 * 2. **No shells or interpreters**, unless a credential names one explicitly.
 *    `hypergate run -- sh -c env` is the one-line way to read every injected
 *    value, and so is `python -c`, `node -e`, `osascript`, `awk 'BEGIN{...}'`.
 * 3. **Credentials are bound to programs.** A credential carries `programs`
 *    (defaulting to the CLIs its guide says it authenticates), and is only ever
 *    injected into one of those.
 *
 * What this is NOT: a sandbox. It is best effort against a cooperating-but-
 * careless agent, and it raises the bar for a hostile one, but a bound program
 * that can itself run arbitrary code still can: `npm install` runs lifecycle
 * scripts, `gh` runs shell aliases (`gh alias set x '!env'`) and extensions,
 * `git` runs `!` aliases. The tables below close the documented, obvious doors;
 * they do not claim to close every one. The real boundary is an OS sandbox
 * around the agent (see the lockdown feature's Phase 4).
 */

/**
 * Shells, interpreters and exec wrappers that are never handed a credential
 * unless a credential lists them by name. Matched against the normalised
 * program name (see `programName`). Prefix entries end in `*`.
 */
export const REFUSED_PROGRAMS: readonly string[] = [
  // POSIX and Windows shells
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'csh', 'tcsh', 'ash', 'busybox',
  'nu', 'elvish', 'xonsh', 'pwsh', 'powershell', 'cmd',
  // exec wrappers: each one runs whatever it is given next
  'env', 'xargs', 'nohup', 'sudo', 'doas', 'exec', 'time', 'nice', 'timeout', 'script', 'expect', 'watch',
  // interpreters
  'python*', 'py', 'node', 'nodejs', 'bun', 'bunx', 'deno', 'ruby', 'irb', 'perl', 'php',
  'osascript', 'lua', 'luajit', 'tclsh', 'wish', 'awk', 'gawk', 'mawk', 'nawk',
  // package runners that execute an arbitrary package
  'npx', 'pnpx', 'uvx',
];

/**
 * Commands a curated CLI is also installed as. The vendor's install creates
 * both names (Fly's installer links `fly` beside `flyctl`), so a credential
 * bound to the catalog id must accept either.
 */
const CLI_ALIASES: Record<string, string[]> = {
  flyctl: ['fly'],
};

/**
 * A program name as policy sees it: the basename, without a Windows executable
 * extension, lower-cased on Windows (where `GH.EXE` and `gh` are the same file).
 */
export const programName = (program: string, platform: string = process.platform): string => {
  const base = program.split(/[\\/]/).pop() ?? program;
  if (platform !== 'win32') return base;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
};

/** Whether a normalised program name is a shell, interpreter or exec wrapper. */
export const isRefusedProgram = (name: string): boolean =>
  REFUSED_PROGRAMS.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));

/**
 * The programs a credential defaults to when nobody bound it: the commands of
 * the curated CLIs its guide authenticates, plus their vendor aliases.
 *
 * `commandFor` maps a curated CLI id (`flyctl`) to its command, so this stays
 * pure: the caller passes the catalog lookup in.
 */
export const defaultProgramsFor = (
  guideClis: readonly string[] | undefined,
  commandFor: (cliId: string) => string | undefined,
): string[] => {
  const out = new Set<string>();
  for (const id of guideClis ?? []) {
    const cmd = commandFor(id);
    if (!cmd) continue;
    out.add(cmd);
    for (const alias of CLI_ALIASES[cmd] ?? []) out.add(alias);
  }
  return [...out];
};

/** Normalise a user-supplied programs list: names only, deduped, no blanks. */
export const normalisePrograms = (programs: readonly unknown[], platform: string = process.platform): string[] => {
  const out: string[] = [];
  for (const p of programs) {
    if (typeof p !== 'string') continue;
    const name = programName(p.trim(), platform);
    if (!name || !/^[\w.+-]{1,64}$/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
};

/**
 * One invocation that prints, or mints and prints, a secret.
 *
 * Every row is the vendor's own documented command; none is guessed. Matching:
 * the `words` must appear as a contiguous run among the positional arguments
 * (anything not starting with `-`), and when `flags` is set, one of them must
 * also be present (`--show-token` or `--show-token=...`). That is deliberately
 * loose in the refusing direction: `gh search code auth token` is refused too,
 * which costs a rare false positive and never a leak.
 */
export interface TokenPrinter {
  /** Program names this applies to (normalised). */
  programs: string[];
  /** Positional words, in order. */
  words: string[];
  /** When set, only refused if one of these flags is also present. */
  flags?: string[];
  /** What it does, for the refusal message. */
  what: string;
}

export const TOKEN_PRINTERS: readonly TokenPrinter[] = [
  // GitHub CLI: `gh auth token` prints the token gh is using (GH_TOKEN wins);
  // `gh auth status -t/--show-token` prints it in the status block;
  // `gh auth git-credential` is the git credential helper protocol, which
  // answers `get` with the token on stdout.
  { programs: ['gh'], words: ['auth', 'token'], what: 'prints the GitHub token' },
  { programs: ['gh'], words: ['auth', 'status'], flags: ['-t', '--show-token'], what: 'prints the GitHub token' },
  { programs: ['gh'], words: ['auth', 'git-credential'], what: 'answers the git credential protocol with the GitHub token' },
  // Fly.io: `fly auth token` shows the token in use; `fly tokens create`
  // mints a new token and prints it.
  { programs: ['fly', 'flyctl'], words: ['auth', 'token'], what: 'prints the Fly.io token' },
  { programs: ['fly', 'flyctl'], words: ['tokens', 'create'], what: 'mints and prints a new Fly.io token' },
  // npm: `npm token create` mints and prints a new registry token.
  { programs: ['npm'], words: ['token', 'create'], what: 'mints and prints a new npm token' },
  // Heroku: `heroku auth:token` prints the CLI token.
  { programs: ['heroku'], words: ['auth:token'], what: 'prints the Heroku token' },
  // Google Cloud: the print-*-token family prints a usable OAuth/ID token.
  { programs: ['gcloud'], words: ['auth', 'print-access-token'], what: 'prints a Google Cloud access token' },
  { programs: ['gcloud'], words: ['auth', 'print-identity-token'], what: 'prints a Google Cloud identity token' },
  { programs: ['gcloud'], words: ['auth', 'application-default', 'print-access-token'], what: 'prints a Google Cloud access token' },
  // Azure: `az account get-access-token` prints an access token.
  { programs: ['az'], words: ['account', 'get-access-token'], what: 'prints an Azure access token' },
  // AWS: `configure get` reads a stored value (including the secret key),
  // `configure export-credentials` prints the resolved credentials, and
  // `sts get-session-token` mints and prints temporary credentials.
  { programs: ['aws'], words: ['configure', 'get'], what: 'prints a stored AWS setting, including secret keys' },
  { programs: ['aws'], words: ['configure', 'export-credentials'], what: 'prints the AWS credentials' },
  { programs: ['aws'], words: ['sts', 'get-session-token'], what: 'mints and prints temporary AWS credentials' },
  // npm subcommands that run arbitrary package scripts or binaries with the
  // injected environment. Not token printers, but the same leak one step
  // removed. (`npm install` lifecycle scripts remain an open door; see above.)
  { programs: ['npm'], words: ['exec'], what: 'runs an arbitrary package binary with the key in its environment' },
  { programs: ['npm'], words: ['x'], what: 'runs an arbitrary package binary with the key in its environment' },
  { programs: ['npm'], words: ['explore'], what: 'opens a shell with the key in its environment' },
  { programs: ['npm'], words: ['run'], what: 'runs a package script with the key in its environment' },
  { programs: ['npm'], words: ['run-script'], what: 'runs a package script with the key in its environment' },
  // GitHub CLI extensions are arbitrary programs that inherit the environment.
  { programs: ['gh'], words: ['extension', 'exec'], what: 'runs a gh extension with the token in its environment' },
  { programs: ['gh'], words: ['ext', 'exec'], what: 'runs a gh extension with the token in its environment' },
];

const containsRun = (haystack: readonly string[], needle: readonly string[]): boolean => {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
};

/** The first token-printing rule an invocation matches, if any. */
export const tokenPrinterFor = (name: string, args: readonly string[]): TokenPrinter | undefined => {
  const positionals = args.filter((a) => !a.startsWith('-'));
  return TOKEN_PRINTERS.find((rule) => {
    if (!rule.programs.includes(name)) return false;
    if (!containsRun(positionals, rule.words)) return false;
    if (!rule.flags) return true;
    return args.some((a) => rule.flags!.some((f) => a === f || a.startsWith(`${f}=`)));
  });
};

/** A credential as the run check sees it. */
export interface LockdownCredential {
  id: string;
  /** Programs a person bound explicitly. */
  programs?: string[];
  /** Programs derived from the credential's guide, used when `programs` is absent. */
  defaultPrograms?: string[];
}

export type LockdownRunVerdict =
  | { ok: true; ids: string[]; program: string }
  | {
      ok: false;
      status: 400 | 403;
      code: 'program_required' | 'token_printer' | 'interpreter' | 'not_bound';
      error: string;
    };

/** The programs a credential may be injected into, and whether a person chose them. */
export const effectivePrograms = (c: LockdownCredential): { programs: string[]; explicit: boolean } =>
  c.programs ? { programs: c.programs, explicit: true } : { programs: c.defaultPrograms ?? [], explicit: false };

/**
 * Decide one `hypergate run` under lockdown.
 *
 * `candidates` are the credentials the caller is already allowed (grant
 * filtering happens before this). `requestedIds` is `--with`: when present, every
 * one of them must be bound to the program or the whole run is refused, because
 * silently dropping a key the caller asked for would just turn the refusal into
 * a confusing "not logged in". When absent, the run gets exactly the allowed
 * credentials bound to this program, which may be none.
 */
export const checkLockdownRun = (input: {
  program?: string;
  args?: readonly string[];
  requestedIds?: readonly string[];
  candidates: readonly LockdownCredential[];
  platform?: string;
}): LockdownRunVerdict => {
  if (!input.program || !input.program.trim()) {
    return {
      ok: false,
      status: 400,
      code: 'program_required',
      error:
        'Credential lockdown is on, so Hypergate needs to know which program a credential is for. Update the hypergate CLI and run the command through "hypergate run -- <command>".',
    };
  }
  const name = programName(input.program.trim(), input.platform);
  const args = input.args ?? [];

  const printer = tokenPrinterFor(name, args);
  if (printer) {
    return {
      ok: false,
      status: 403,
      code: 'token_printer',
      error: `Refused under credential lockdown: "${name} ${printer.words.join(' ')}" ${printer.what}. Run the command that needs the key instead; Hypergate injects it without anyone seeing it.`,
    };
  }

  const bound = (c: LockdownCredential): boolean => {
    const { programs, explicit } = effectivePrograms(c);
    if (!programs.includes(name)) return false;
    // A shell or interpreter only ever gets a key a person bound to it by name.
    return !isRefusedProgram(name) || explicit;
  };

  if (input.requestedIds && input.requestedIds.length) {
    const byId = new Map(input.candidates.map((c) => [c.id, c]));
    for (const id of input.requestedIds) {
      const c = byId.get(id);
      // Grant filtering already refused unknown or ungranted ids; treat a
      // stray one as unbound rather than trusting it.
      if (!c || !bound(c)) {
        if (isRefusedProgram(name)) return interpreterRefusal(name);
        const allowed = c ? effectivePrograms(c).programs : [];
        return {
          ok: false,
          status: 403,
          code: 'not_bound',
          error: `Refused under credential lockdown: credential "${id}" is not bound to "${name}"${
            allowed.length ? ` (it is for: ${allowed.join(', ')})` : ' (it is not bound to any program yet)'
          }. A person can bind it with "hypergate cred programs ${id} ${name}".`,
        };
      }
    }
    return { ok: true, ids: [...input.requestedIds], program: name };
  }

  const ids = input.candidates.filter(bound).map((c) => c.id);
  if (!ids.length && isRefusedProgram(name)) return interpreterRefusal(name);
  return { ok: true, ids, program: name };
};

const interpreterRefusal = (name: string): LockdownRunVerdict => ({
  ok: false,
  status: 403,
  code: 'interpreter',
  error: `Refused under credential lockdown: "${name}" is a shell or interpreter, and handing it a key would let anything it runs read the key. Run the CLI that needs the key directly, e.g. "hypergate run -- gh repo list".`,
});

/**
 * The exact command an agent should use instead of fetching a value, returned by
 * `credential_env` under lockdown. Quoted only as much as a shell needs.
 */
export const lockdownRunLine = (credentialId: string, agentKey?: string): string => {
  const q = (s: string): string => (/^[\w.:@/+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return `hypergate run${agentKey ? ` --agent ${q(agentKey)}` : ''} --with ${q(credentialId)} -- <command>`;
};
