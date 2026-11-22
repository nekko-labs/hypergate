import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The daemon's own autostart, i.e. the path taken when the Rust shell is not
 * installed. That case used to be "the toggle does nothing and the UI says
 * autostart isn't wired up yet", so the thing worth pinning down is that it now
 * writes a real login item — and that it delegates instead when a shell exists.
 *
 * The Windows branch drives `reg.exe`, so it is exercised live only on Windows;
 * the POSIX branches write files, which we can check anywhere by pointing HOME
 * (macOS) or XDG_CONFIG_HOME (Linux) at a temp dir.
 */

const shell = { hasShell: vi.fn(() => false), autostartEnabled: vi.fn(() => false), setAutostart: vi.fn(() => true), shellBin: vi.fn(() => undefined as string | undefined) };
vi.mock('./shell.ts', () => shell);

const load = async () => {
  vi.resetModules();
  return import('./autostart.ts');
};

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hg-autostart-'));
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  // Never the real "Hypergate" Run value: a test that touched it once left the
  // user's login item running a test worker from a deleted worktree.
  process.env.HYPERGATE_AUTOSTART_VALUE = `Hypergate-test-${process.pid}`;
  shell.hasShell.mockReturnValue(false);
  shell.shellBin.mockReturnValue(undefined);
  shell.setAutostart.mockReturnValue(true);
  shell.autostartEnabled.mockReturnValue(false);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
  vi.clearAllMocks();
});

describe('who owns the login item', () => {
  it('delegates to the shell binary when one is installed', async () => {
    shell.hasShell.mockReturnValue(true);
    shell.shellBin.mockReturnValue('/opt/hypergate/hypergate');
    const autostart = await load();
    expect(autostart.via()).toBe('shell');
    expect(autostart.startupCommand()).toBe('/opt/hypergate/hypergate tray');

    autostart.set(true);
    expect(shell.setAutostart).toHaveBeenCalledWith(true);

    shell.autostartEnabled.mockReturnValue(true);
    expect(autostart.enabled()).toBe(true);
  });

  it('says so rather than failing silently when the shell refuses', async () => {
    shell.hasShell.mockReturnValue(true);
    shell.setAutostart.mockReturnValue(false);
    const autostart = await load();
    expect(() => autostart.set(true)).toThrow(/could not change the login item/);
  });

  it('writes the item itself when there is no shell', async () => {
    const autostart = await load();
    expect(autostart.via()).toBe('daemon');
    expect(autostart.supported()).toBe(true);
  });

  it('launches something that actually exists', async () => {
    const autostart = await load();
    const argv = autostart.launchCommandArgv();
    expect(argv, 'no launch command resolved').toBeTruthy();
    // Whatever we picked, the executable must be real — a login item pointing
    // at a path that isn't there is worse than no login item.
    expect(existsSync(argv![0])).toBe(true);
  });

  it('quotes a path with spaces so the OS runs one command, not two', async () => {
    const autostart = await load();
    const command = autostart.startupCommand()!;
    const argv = autostart.launchCommandArgv()!;
    if (argv.some((a) => a.includes(' '))) expect(command).toContain('"');
    // Every argument survives into the rendered command.
    for (const a of argv) expect(command).toContain(a.replaceAll('"', '\\"'));
  });
});

describe.runIf(process.platform === 'linux')('linux: an XDG autostart entry', () => {
  const entry = (): string => join(process.env.XDG_CONFIG_HOME!, 'autostart', 'hypergate.desktop');

  it('round-trips, and is idempotent both ways', async () => {
    const autostart = await load();
    expect(autostart.enabled()).toBe(false);

    autostart.set(true);
    expect(autostart.enabled()).toBe(true);
    const text = readFileSync(entry(), 'utf8');
    expect(text).toContain('Type=Application');
    expect(text).toContain('Name=Hypergate');
    expect(text.split('\n').find((l) => l.startsWith('Exec='))).toBeTruthy();

    autostart.set(true); // enabling twice must not double anything up
    expect(autostart.enabled()).toBe(true);

    autostart.set(false);
    expect(autostart.enabled()).toBe(false);
    autostart.set(false); // disabling a missing item is success, not an error
    expect(autostart.enabled()).toBe(false);
  });

  it('escapes spaces inside an argument, which the Desktop Entry spec splits on', async () => {
    const autostart = await load();
    autostart.set(true);
    const argv = autostart.launchCommandArgv()!;
    const exec = readFileSync(entry(), 'utf8').split('\n').find((l) => l.startsWith('Exec='))!.slice('Exec='.length);
    // Only the separators between arguments may be bare spaces: splitting on
    // those must give back exactly the argv we meant, however many spaces a
    // path happens to contain.
    const parts = exec.split(/(?<!\\) /);
    expect(parts).toHaveLength(argv.length);
    expect(parts.map((p) => p.replaceAll('\\ ', ' ').replaceAll('\\\\', '\\'))).toEqual(argv);
  });
});

describe.runIf(process.platform === 'win32')('windows: the HKCU Run key', () => {
  it('round-trips through the real registry', async () => {
    const autostart = await load();
    try {
      autostart.set(true);
      expect(autostart.enabled()).toBe(true);
      autostart.set(false);
      expect(autostart.enabled()).toBe(false);
      // Removing an item that isn't there is success: the toggle must be
      // idempotent, or a second click reports a failure for a no-op.
      expect(() => autostart.set(false)).not.toThrow();
    } finally {
      // A throwaway value (HYPERGATE_AUTOSTART_VALUE), so cleaning up is deleting it.
      autostart.set(false);
    }
  });
});

describe('repairing a login item left behind by an update or a move', () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it('flags the test worker an old test wrote into the real Run key', async () => {
    const { staleReason } = await load();
    const written =
      String.raw`"C:\Program Files\nodejs\node.exe" --experimental-import-meta-resolve --require C:/Users/me/code/.worktrees/hg/node_modules/vitest/suppress-warnings.cjs --conditions node C:\Users\me\code\.worktrees\hg\node_modules\vitest\dist\workers\forks.js`;
    expect(staleReason(written, () => true)).toBe('it starts a test worker, not Hypergate');
  });

  it('flags a program or script that is gone, and passes one that is there', async () => {
    const { staleReason } = await load();
    const tray = String.raw`C:\Users\me\AppData\Local\Programs\Hypergate\hypergate.exe`;
    expect(staleReason(`"${tray}" tray`, exists([]))).toBe(`${tray} no longer exists`);
    expect(staleReason(`"${tray}" tray`, exists([tray]))).toBeUndefined();
    const node = '/usr/local/bin/node';
    const script = '/home/me/old-checkout/apps/daemon/src/index.ts';
    expect(staleReason(`${node} --experimental-strip-types ${script}`, exists([node]))).toBe(`${script} no longer exists`);
    expect(staleReason(`${node} --experimental-strip-types ${script}`, exists([node, script]))).toBeUndefined();
    // A bare name on PATH is the OS's to resolve; not ours to call stale.
    expect(staleReason('hypergated', exists([]))).toBeUndefined();
  });

  it('splits a quoted command line into its arguments', async () => {
    const { splitCommand } = await load();
    expect(splitCommand(String.raw`"C:\Program Files\x\hypergate.exe" tray`)).toEqual([String.raw`C:\Program Files\x\hypergate.exe`, 'tray']);
    expect(splitCommand('/usr/bin/node a.js  --flag')).toEqual(['/usr/bin/node', 'a.js', '--flag']);
  });

  it('leaves no login item alone: an update never turns one on', async () => {
    delete process.env.VITEST;
    const autostart = await load();
    if (autostart.enabled()) autostart.set(false);
    expect(autostart.repair()).toBeUndefined();
    expect(autostart.enabled()).toBe(false);
  });

  it.runIf(process.platform === 'linux')('rewrites a stale entry to start this install', async () => {
    const autostart = await load();
    autostart.set(true);
    const entry = join(home, '.config', 'autostart', 'hypergate.desktop');
    const text = readFileSync(entry, 'utf8').replace(/^Exec=.*$/m, 'Exec=/gone/checkout/hypergated');
    (await import('node:fs')).writeFileSync(entry, text);
    expect(autostart.registeredCommand()).toBe('/gone/checkout/hypergated');
    delete process.env.VITEST;
    expect(autostart.repair()).toBe('/gone/checkout/hypergated no longer exists');
    expect(autostart.registeredCommand()).not.toContain('/gone/');
  });

  it('refuses to write a command that is stale itself (a test run)', async () => {
    const autostart = await load();
    // Under vitest the last-resort launch command is the test worker.
    delete process.env.VITEST;
    expect(autostart.staleReason(autostart.startupCommand() ?? '')).toBeDefined();
  });
});
