import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CliJob, CliJobAction } from '@hypergate/shared';

/**
 * Lifecycle commands the daemon runs against CLIs on the user's behalf:
 * install, uninstall, repair, re-authenticate. One class owns the running
 * children and their captured output, so the routes stay thin and the UI can
 * poll a plain JSON snapshot the way it already polls update progress.
 *
 * Safety model, restated where it is enforced:
 * - argv reaches this class already derived from catalog data and validated by
 *   `parseCuratedCommand` (or a curated auth hint); it is never request text.
 * - spawns are shell-free, stdin is closed immediately (a tool that wants a TTY
 *   fails fast with its own message instead of hanging on a prompt nobody can
 *   answer), and a hard timeout plus a kill route bound the damage of a hang.
 * - one job per tool at a time, and a bounded history so memory cannot grow.
 */

const LINE_CAP = 2000;
const HISTORY_CAP = 20;
const TIMEOUT_MS = 15 * 60_000;
const WIN = process.platform === 'win32';

interface JobRecord {
  job: CliJob;
  child?: ReturnType<typeof spawn>;
  timer?: NodeJS.Timeout;
  killed?: boolean;
}

export class CliJobRunner {
  private records = new Map<string, JobRecord>();
  // Plain field, not a parameter property: the daemon runs under
  // `--experimental-strip-types`, which cannot express those.
  private onDone?: (job: CliJob) => void;

  constructor(onDone?: (job: CliJob) => void) {
    this.onDone = onDone;
  }

  /** The job currently running for a tool, if any. */
  running(cliId: string): CliJob | undefined {
    for (const r of this.records.values()) {
      if (r.job.cliId === cliId && r.job.status === 'running') return snapshot(r.job);
    }
    return undefined;
  }

  get(id: string): CliJob | undefined {
    const r = this.records.get(id);
    return r ? snapshot(r.job) : undefined;
  }

  /** Newest first. */
  list(): CliJob[] {
    return [...this.records.values()]
      .map((r) => snapshot(r.job))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Spawn one lifecycle command. Throws when a job for this tool is already
   * running: the caller turns that into a 409.
   */
  start(opts: { cliId: string; name: string; action: CliJobAction; argv: string[]; command: string }): CliJob {
    if (this.running(opts.cliId)) throw new Error(`a job for ${opts.cliId} is already running`);
    const job: CliJob = {
      id: randomUUID(),
      cliId: opts.cliId,
      name: opts.name,
      action: opts.action,
      command: opts.command,
      status: 'running',
      lines: [],
      startedAt: Date.now(),
    };
    const record: JobRecord = { job };
    this.records.set(job.id, record);
    this.prune();

    const [file, ...args] = opts.argv;
    // Windows package managers are .cmd shims Node refuses to spawn directly.
    const resolved = WIN ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] } : { file, args };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolved.file, resolved.args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.finish(record, 'failed', undefined, e instanceof Error ? e.message : String(e));
      return snapshot(job);
    }
    record.child = child;
    record.timer = setTimeout(() => {
      record.killed = true;
      job.error = `still running after ${TIMEOUT_MS / 60_000} minutes; stopped`;
      child.kill();
    }, TIMEOUT_MS);
    record.timer.unref?.();

    const push = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        job.lines.push(line);
        if (job.lines.length > LINE_CAP) job.lines.splice(0, job.lines.length - LINE_CAP, '… earlier output dropped …');
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (e) => this.finish(record, 'failed', undefined, e.message));
    child.on('close', (code) => {
      if (job.status !== 'running') return; // spawn error already finished it
      if (record.killed) this.finish(record, job.error ? 'failed' : 'killed', code ?? undefined, job.error);
      else this.finish(record, code === 0 ? 'succeeded' : 'failed', code ?? undefined);
    });
    return snapshot(job);
  }

  /** Stop a running job. True when there was one to stop. */
  kill(id: string): boolean {
    const r = this.records.get(id);
    if (!r || r.job.status !== 'running' || !r.child) return false;
    r.killed = true;
    r.child.kill();
    return true;
  }

  private finish(record: JobRecord, status: CliJob['status'], exitCode?: number, error?: string): void {
    if (record.timer) clearTimeout(record.timer);
    record.job.status = status;
    record.job.exitCode = exitCode;
    if (error) record.job.error = error;
    record.job.endedAt = Date.now();
    this.onDone?.(snapshot(record.job));
  }

  /** Keep finished history bounded; running jobs are never pruned. */
  private prune(): void {
    const finished = [...this.records.values()].filter((r) => r.job.status !== 'running').sort((a, b) => a.job.startedAt - b.job.startedAt);
    while (finished.length > 0 && this.records.size > HISTORY_CAP) {
      const oldest = finished.shift()!;
      this.records.delete(oldest.job.id);
    }
  }
}

const snapshot = (job: CliJob): CliJob => ({ ...job, lines: [...job.lines] });
