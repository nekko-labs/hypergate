import type { ManagedServerConfig, ResourceLimits, RuntimeKind, SpawnSpec } from '@hypergate/shared';

/**
 * RuntimeAdapter — turns a server config into the concrete stdio process to
 * launch. The whole isolation model lives here: both modes reduce to "what
 * command do we spawn." Process = the server's own command with a scrubbed,
 * allow-listed env. Docker = `docker run -i … image` (the same stdio mechanism,
 * but containerized). Pick at setup; override per server.
 */
export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  spawnSpec(config: ManagedServerConfig): SpawnSpec;
}

// The minimal env a child needs to run — we do NOT inherit the full process
// env, so the user's ambient secrets never leak into a managed server.
const BASE_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'APPDATA', 'ProgramFiles', 'ProgramData'];

const baseEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
};

const declaredEnv = (config: ManagedServerConfig): Record<string, string> => ({
  ...(config.env ?? {}),
  ...(config.secrets ?? {}),
});

/**
 * Where the `hypergate` shell binary is, when one is installed.
 *
 * Injected rather than probed so core stays IO-free and unit-testable; the daemon
 * resolves it once at boot. `undefined` means "no launcher available", in which
 * case a server with limits still starts, just unenforced.
 */
export interface LauncherOptions {
  /** Absolute path to the `hypergate` binary, or `undefined` when absent. */
  launcher?: string;
}

/**
 * Wrap a command in `hypergate sandbox-exec` so the OS enforces the limits.
 *
 * Returns the original command untouched when there is nothing to enforce or no
 * launcher to enforce it with. The launcher inherits stdio, so the MCP stdio
 * stream is unaffected by the extra process in the middle.
 */
const withSandbox = (
  command: string,
  args: string[],
  limits: ResourceLimits | undefined,
  launcher: string | undefined,
): { command: string; args: string[] } => {
  const flags: string[] = [];
  if (limits?.memMb) flags.push('--mem', String(limits.memMb));
  if (limits?.cpuPct) flags.push('--cpu', String(limits.cpuPct));
  if (limits?.nofile) flags.push('--nofile', String(limits.nofile));
  // No launcher, or nothing to ask for: spawn directly. Note that the launcher
  // is worth using even with no limits, for its process-tree teardown, but we
  // only take that dependency when the user has actually asked for isolation.
  if (!launcher || flags.length === 0) return { command, args };
  return { command: launcher, args: ['sandbox-exec', ...flags, '--', command, ...args] };
};

/** Default, dependency-free isolation: a scrubbed-env child process, no shell. */
export class ProcessRuntime implements RuntimeAdapter {
  readonly kind = 'process' as const;
  constructor(private opts: LauncherOptions = {}) {}
  spawnSpec(config: ManagedServerConfig): SpawnSpec {
    const { command, args } = withSandbox(config.command, config.args ?? [], config.limits, this.opts.launcher);
    return {
      command,
      args,
      env: { ...baseEnv(), ...declaredEnv(config) },
      cwd: config.cwd,
    };
  }
}

/** Opt-in strong isolation: one container per server (`docker run -i …`). */
export class DockerRuntime implements RuntimeAdapter {
  readonly kind = 'docker' as const;
  spawnSpec(config: ManagedServerConfig): SpawnSpec {
    if (!config.image) throw new Error(`docker runtime needs an image for server "${config.id}"`);
    const envFlags = Object.entries(declaredEnv(config)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = [
      'run',
      '--rm',
      '-i',
      '--pull',
      'missing',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      ...envFlags,
      config.image,
      // append the in-container command only if one is specified (else the
      // image's own entrypoint runs).
      ...(config.command ? [config.command, ...(config.args ?? [])] : []),
    ];
    return { command: 'docker', args, env: baseEnv() };
  }
}

export const runtimeFor = (kind: RuntimeKind, opts: LauncherOptions = {}): RuntimeAdapter =>
  kind === 'docker' ? new DockerRuntime() : new ProcessRuntime(opts);
