import type { ManagedServerConfig, RuntimeKind, SpawnSpec } from '@hypergate/shared';

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

/** Default, dependency-free isolation: a scrubbed-env child process, no shell. */
export class ProcessRuntime implements RuntimeAdapter {
  readonly kind = 'process' as const;
  spawnSpec(config: ManagedServerConfig): SpawnSpec {
    return {
      command: config.command,
      args: config.args ?? [],
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

export const runtimeFor = (kind: RuntimeKind): RuntimeAdapter =>
  kind === 'docker' ? new DockerRuntime() : new ProcessRuntime();
