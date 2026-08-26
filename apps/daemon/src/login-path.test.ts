import { describe, expect, it } from 'vitest';
import { looksLikeStubPath, mergePath, parseShellPath, resolveUserPath, wellKnownDirs } from './login-path.ts';

/** Only the paths named here "exist", so the tests never depend on the host. */
const existsIn = (dirs: string[]) => (p: string) => dirs.includes(p);

describe('looksLikeStubPath', () => {
  it('recognises what launchd hands a GUI process', () => {
    // The exact value observed on a Mac where the login item was enabled.
    expect(looksLikeStubPath('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true);
    expect(looksLikeStubPath('/usr/bin:/bin:/usr/sbin:/sbin:')).toBe(true);
    expect(looksLikeStubPath('/bin:/usr/bin')).toBe(true);
    expect(looksLikeStubPath('')).toBe(true);
    expect(looksLikeStubPath(undefined)).toBe(true);
  });

  it('leaves a real shell PATH alone', () => {
    expect(looksLikeStubPath('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')).toBe(false);
    expect(looksLikeStubPath('/Users/x/.bun/bin:/usr/bin:/bin')).toBe(false);
  });
});

describe('wellKnownDirs', () => {
  it('offers the macOS install locations, and only ones that exist', () => {
    const dirs = wellKnownDirs({
      platform: 'darwin',
      home: '/Users/x',
      exists: existsIn(['/opt/homebrew/bin', '/Users/x/.bun/bin']),
    });
    expect(dirs).toEqual(['/opt/homebrew/bin', '/Users/x/.bun/bin']);
    // A PATH full of directories that are not there slows every lookup in every
    // child for nothing, so absent ones are dropped rather than hopefully added.
    expect(dirs).not.toContain('/opt/local/bin');
  });

  it('offers linuxbrew on Linux and neither set on Windows', () => {
    const linux = wellKnownDirs({
      platform: 'linux',
      home: '/home/x',
      exists: existsIn(['/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin']),
    });
    expect(linux).toContain('/home/linuxbrew/.linuxbrew/bin');
    expect(linux).not.toContain('/opt/homebrew/bin');
    expect(wellKnownDirs({ platform: 'win32', home: 'C:/u', exists: () => true })).not.toContain('/opt/homebrew/bin');
  });
});

describe('mergePath', () => {
  it('appends without reordering or duplicating what is already there', () => {
    expect(mergePath('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/bin'])).toBe('/usr/bin:/bin:/opt/homebrew/bin');
    expect(mergePath('', ['/a', '/b'])).toBe('/a:/b');
    expect(mergePath('/a', [])).toBe('/a');
  });
});

describe('parseShellPath', () => {
  it('finds the answer inside whatever the rc files printed', () => {
    const noisy = [
      'Last login: Tue Aug 26',
      'nvm: v20 in use',
      '__hypergate_path_start__/opt/homebrew/bin:/usr/bin__hypergate_path_end__',
      'you have mail',
    ].join('\n');
    expect(parseShellPath(noisy)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('answers nothing rather than guessing when the markers are absent', () => {
    expect(parseShellPath('some banner text')).toBeUndefined();
    expect(parseShellPath('__hypergate_path_start__/opt/bin')).toBeUndefined(); // truncated
    expect(parseShellPath('__hypergate_path_start____hypergate_path_end__')).toBeUndefined(); // empty
  });
});

describe('resolveUserPath', () => {
  const shellSays = (value?: string) => async (): Promise<string | undefined> => value;

  it('leaves a terminal-launched daemon exactly as it was, asking no shell', async () => {
    let asked = false;
    const result = await resolveUserPath({
      current: '/opt/homebrew/bin:/usr/bin:/bin',
      platform: 'darwin',
      shellPath: async () => {
        asked = true;
        return '/should/not/be/used';
      },
    });
    expect(result).toEqual({ path: '/opt/homebrew/bin:/usr/bin:/bin', source: 'inherited' });
    expect(asked, 'a healthy PATH must not cost a subprocess at boot').toBe(false);
  });

  it('repairs a launchd stub from the login shell', async () => {
    const result = await resolveUserPath({
      current: '/usr/bin:/bin:/usr/sbin:/sbin',
      platform: 'darwin',
      home: '/Users/x',
      exists: existsIn(['/opt/homebrew/bin']),
      shellPath: shellSays('/Users/x/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin'),
    });
    expect(result.source).toBe('login-shell');
    // nvm is exactly the case a static directory list cannot cover.
    expect(result.path).toContain('/Users/x/.nvm/versions/node/v22/bin');
    expect(result.path.split(':').filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('falls back to the directories that exist when the shell cannot answer', async () => {
    const result = await resolveUserPath({
      current: '/usr/bin:/bin:/usr/sbin:/sbin',
      platform: 'darwin',
      home: '/Users/x',
      exists: existsIn(['/opt/homebrew/bin', '/Users/x/.cargo/bin']),
      shellPath: shellSays(undefined),
    });
    expect(result.source).toBe('well-known');
    expect(result.path).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Users/x/.cargo/bin');
  });

  it('ignores a shell that only echoes the stub back', async () => {
    const result = await resolveUserPath({
      current: '/usr/bin:/bin:/usr/sbin:/sbin',
      platform: 'darwin',
      home: '/Users/x',
      exists: existsIn(['/opt/homebrew/bin']),
      shellPath: shellSays('/usr/bin:/bin:/usr/sbin:/sbin'),
    });
    expect(result.source).toBe('well-known');
    expect(result.path).toContain('/opt/homebrew/bin');
  });

  it('never repairs on Windows, where the OS already gives the real PATH', async () => {
    const result = await resolveUserPath({
      current: 'C:\\Windows\\system32',
      platform: 'win32',
      shellPath: shellSays('/should/not/be/used'),
    });
    expect(result).toEqual({ path: 'C:\\Windows\\system32', source: 'inherited' });
  });
});
