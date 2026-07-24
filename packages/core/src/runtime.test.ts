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
