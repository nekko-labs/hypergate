// `npm run dev`: runs dev-all.mjs, and again each time it asks to restart.
//
// The launcher's r key ends it with RESTART; this loop then starts a fresh
// one, so a restart picks up everything a pull changed, the launcher included.
// It never reads stdin: the launcher owns the keyboard. (Relaunching from
// inside the launcher hung on Windows, where a child inheriting a stdin the
// parent still has a read pending on blocks at startup.)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The exit code dev-all.mjs uses for "start me again". */
export const RESTART = 75;

const launcher = fileURLToPath(new URL('./dev-all.mjs', import.meta.url));
// Ctrl+C outside a raw-mode terminal reaches the whole console group; the
// launcher decides what it means (stop cleanly, then force), not this loop.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

for (;;) {
  const r = spawnSync(process.execPath, [launcher, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HYPERGATE_DEV_LOOP: '1' } });
  if (r.status !== RESTART) process.exit(r.status ?? 1);
}
