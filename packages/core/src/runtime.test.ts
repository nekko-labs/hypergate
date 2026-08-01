import { describe, it, expect } from 'vitest';
import { ProcessRuntime, DockerRuntime, runtimeFor } from './runtime.js';
import type { ManagedServerConfig } from '@hypergate/shared';

const base: ManagedServerConfig = { id: 'x', name: 'X', runtime: 'process', command: 'mycmd', args: ['--flag'], enabled: true };

describe('ProcessRuntime', () => {
  it('passes command/args and an allow-listed env (no host-secret leak)', () => {
    process.env.SECRET_X_LEAK = 'nope';
    const spec = new ProcessRuntime().spawnSpec({ ...base, env: { FOO: 'bar' }, secrets: { TOKEN: 't' } });
    expect(spec.command).toBe('mycmd');
    expect(spec.args).toEqual(['--flag']);
    expect(spec.env.FOO).toBe('bar');
    expect(spec.env.TOKEN).toBe('t');
    expect(spec.env.SECRET_X_LEAK).toBeUndefined();
    delete process.env.SECRET_X_LEAK;
  });
});

describe('ProcessRuntime resource limits', () => {
  const LAUNCHER = '/usr/local/bin/hypergate';

  it('spawns directly when no limits are configured, even with a launcher present', () => {
    const spec = new ProcessRuntime({ launcher: LAUNCHER }).spawnSpec(base);
    expect(spec.command).toBe('mycmd');
    expect(spec.args).toEqual(['--flag']);
  });

  it('wraps the command in `sandbox-exec` when limits are configured', () => {
    const spec = new ProcessRuntime({ launcher: LAUNCHER }).spawnSpec({
      ...base,
      limits: { memMb: 512, cpuPct: 50, nofile: 256 },
    });
    expect(spec.command).toBe(LAUNCHER);
    expect(spec.args).toEqual([
      'sandbox-exec',
      '--mem', '512',
      '--cpu', '50',
      '--nofile', '256',
      '--',
      'mycmd', '--flag',
    ]);
  });

  it('passes only the limits that were actually asked for', () => {
    const spec = new ProcessRuntime({ launcher: LAUNCHER }).spawnSpec({ ...base, limits: { memMb: 256 } });
    expect(spec.args).toEqual(['sandbox-exec', '--mem', '256', '--', 'mycmd', '--flag']);
  });

  it('separates the target command with `--` so its own flags are never parsed as ours', () => {
    const spec = new ProcessRuntime({ launcher: LAUNCHER }).spawnSpec({
      ...base,
      command: 'npx',
      args: ['-y', 'some-server', '--mem', 'not-our-flag'],
      limits: { memMb: 128 },
    });
    const sep = spec.args.indexOf('--');
    expect(spec.args.slice(sep + 1)).toEqual(['npx', '-y', 'some-server', '--mem', 'not-our-flag']);
  });

  it('starts unsandboxed (rather than failing) when no launcher is installed', () => {
    const spec = new ProcessRuntime().spawnSpec({ ...base, limits: { memMb: 512 } });
    expect(spec.command).toBe('mycmd');
    expect(spec.args).toEqual(['--flag']);
  });

  it('ignores a limits object with no actual ceilings in it', () => {
    const spec = new ProcessRuntime({ launcher: LAUNCHER }).spawnSpec({ ...base, limits: {} });
    expect(spec.command).toBe('mycmd');
  });

  it('keeps the scrubbed env when sandboxed', () => {
    process.env.SECRET_Y_LEAK = 'nope';
    const spec = new ProcessRuntime({ launcher: LAUNCHER }).spawnSpec({
      ...base,
      secrets: { TOKEN: 't' },
      limits: { memMb: 64 },
    });
    expect(spec.env.TOKEN).toBe('t');
    expect(spec.env.SECRET_Y_LEAK).toBeUndefined();
    delete process.env.SECRET_Y_LEAK;
  });
});

describe('DockerRuntime', () => {
  it('wraps the server in `docker run -i` with hardening + env flags', () => {
    const spec = new DockerRuntime().spawnSpec({ ...base, runtime: 'docker', image: 'ghcr.io/x/server:1', env: { FOO: 'bar' } });
    expect(spec.command).toBe('docker');
    expect(spec.args.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    expect(spec.args).toContain('--cap-drop');
    expect(spec.args).toContain('ghcr.io/x/server:1');
    expect(spec.args.join(' ')).toContain('-e FOO=bar');
    const imgIdx = spec.args.indexOf('ghcr.io/x/server:1');
    expect(spec.args[imgIdx + 1]).toBe('mycmd'); // in-container command after the image
  });
  it('requires an image', () => {
    expect(() => new DockerRuntime().spawnSpec({ ...base, runtime: 'docker' })).toThrow();
  });
});

describe('runtimeFor', () => {
  it('selects the adapter by kind', () => {
    expect(runtimeFor('docker').kind).toBe('docker');
    expect(runtimeFor('process').kind).toBe('process');
  });
});
