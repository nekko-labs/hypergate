// Shared teardown for the smoke scripts.
import { rmSync } from 'node:fs';

/**
 * Stop the daemon and remove its scratch data dir.
 *
 * Both halves need care on Windows. `child.kill()` maps to TerminateProcess, so
 * the daemon's SIGTERM handler (which closes the SQLite store) never runs, and
 * the db/-wal/-shm handles are only released when the OS reaps the process. A
 * bare `rmSync` right after `kill()` therefore loses the race with EPERM, so we
 * wait for `exit` and then retry the removal.
 */
export const shutdown = async (daemon, dir, { timeoutMs = 5000 } = {}) => {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise((r) => daemon.once('exit', r));
    daemon.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  removeDir(dir);
};

/** Best-effort recursive delete. A leftover temp dir must never fail a smoke run. */
export const removeDir = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* the OS still holds a handle; tmp gets cleaned by the system eventually */
  }
};
