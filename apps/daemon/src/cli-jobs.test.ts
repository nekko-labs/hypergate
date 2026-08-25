import { describe, expect, it } from 'vitest';
import type { CliJob } from '@hypergate/shared';
import { CliJobRunner } from './cli-jobs.ts';

// Real spawns of this test's own node binary: the runner's job is process
// plumbing, so the tests exercise the real thing instead of a mock child.
const node = process.execPath;

const finished = (runner: CliJobRunner, id: string, timeoutMs = 10_000): Promise<CliJob> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const job = runner.get(id);
      if (job && job.status !== 'running') return resolve(job);
      if (Date.now() - started > timeoutMs) return reject(new Error('job never finished'));
      setTimeout(tick, 25);
    };
    tick();
  });

describe('CliJobRunner', () => {
  it('captures output line by line and reports success', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({
      cliId: 'demo',
      name: 'Demo',
      action: 'install',
      command: 'demo install',
      argv: [node, '-e', "console.log('one'); console.error('two'); console.log('three')"],
    });
    expect(job.status).toBe('running');
    const done = await finished(runner, job.id);
    expect(done.status).toBe('succeeded');
    expect(done.exitCode).toBe(0);
    expect(done.lines).toContain('one');
    expect(done.lines).toContain('two');
    expect(done.lines).toContain('three');
    expect(done.endedAt).toBeGreaterThanOrEqual(done.startedAt);
  });

  it('a non-zero exit is a failure carrying the tool’s own output', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({
      cliId: 'demo',
      name: 'Demo',
      action: 'uninstall',
      command: 'demo uninstall',
      argv: [node, '-e', "console.error('no such package'); process.exit(3)"],
    });
    const done = await finished(runner, job.id);
    expect(done.status).toBe('failed');
    expect(done.exitCode).toBe(3);
    expect(done.lines).toContain('no such package');
  });

  it('an unspawnable program fails instead of throwing', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({
      cliId: 'demo',
      name: 'Demo',
      action: 'install',
      command: 'ghost install',
      argv: ['definitely-not-a-real-binary-xyz'],
    });
    const done = await finished(runner, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toBeTruthy();
  });

  it('one job per tool at a time; a second start throws while the first runs', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({
      cliId: 'demo',
      name: 'Demo',
      action: 'install',
      command: 'demo install',
      argv: [node, '-e', 'setTimeout(() => {}, 2000)'],
    });
    expect(() =>
      runner.start({ cliId: 'demo', name: 'Demo', action: 'repair', command: 'demo repair', argv: [node, '-e', ''] }),
    ).toThrow(/already running/);
    // A different tool is fine.
    const other = runner.start({ cliId: 'other', name: 'Other', action: 'install', command: 'x', argv: [node, '-e', ''] });
    expect(runner.kill(job.id)).toBe(true);
    const done = await finished(runner, job.id);
    expect(done.status).toBe('killed');
    await finished(runner, other.id);
  });

  it('kill on a finished or unknown job says no', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({ cliId: 'demo', name: 'Demo', action: 'install', command: 'x', argv: [node, '-e', ''] });
    await finished(runner, job.id);
    expect(runner.kill(job.id)).toBe(false);
    expect(runner.kill('nope')).toBe(false);
  });

  it('caps captured lines, dropping the oldest', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({
      cliId: 'demo',
      name: 'Demo',
      action: 'install',
      command: 'noisy',
      argv: [node, '-e', 'for (let i = 0; i < 2500; i++) console.log(`line ${i}`)'],
    });
    const done = await finished(runner, job.id);
    expect(done.lines.length).toBeLessThanOrEqual(2001);
    expect(done.lines[0]).toContain('earlier output dropped');
    expect(done.lines.at(-1)).toBe('line 2499');
  });

  it('notifies onDone and lists newest first', async () => {
    const seen: string[] = [];
    const runner = new CliJobRunner((j) => seen.push(j.id));
    const a = runner.start({ cliId: 'a', name: 'A', action: 'install', command: 'x', argv: [node, '-e', ''] });
    await finished(runner, a.id);
    const b = runner.start({ cliId: 'b', name: 'B', action: 'install', command: 'x', argv: [node, '-e', ''] });
    await finished(runner, b.id);
    expect(seen).toEqual([a.id, b.id]);
    expect(runner.list().map((j) => j.id)).toEqual([b.id, a.id]);
  });
});

describe('vendor install scripts', () => {
  // The script path is the only one that reaches a shell, so prove both halves:
  // a pipeline really does run, and nothing takes that path without asking.
  it.skipIf(process.platform === 'win32')('runs a pipeline through the shell when the job is a script', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({
      cliId: 'demo',
      name: 'Demo',
      action: 'install',
      command: "echo 'piped output' | tr -d ' '",
      argv: [],
      script: { shell: 'posix' },
    });
    const done = await finished(runner, job.id);
    expect(done.status).toBe('succeeded');
    expect(done.lines).toContain('pipedoutput');
  });

  it.skipIf(process.platform === 'win32')('spawns argv jobs with no shell, so a pipeline is argv and not a pipe', async () => {
    const runner = new CliJobRunner();
    const job = runner.start({
      cliId: 'demo',
      name: 'Demo',
      action: 'install',
      command: 'demo',
      argv: [node, '-e', 'console.log(process.argv.slice(1).join("|"))', '|', 'tr'],
    });
    const done = await finished(runner, job.id);
    expect(done.status).toBe('succeeded');
    // `|` arrived as a literal argument; had a shell been involved it would
    // have been an operator and this output could not exist.
    expect(done.lines.join('\n')).toContain('|');
  });
});
