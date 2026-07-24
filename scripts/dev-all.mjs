// Run the daemon + web UI together. Dependency-free; prefixes output; Ctrl-C
// tears both down. Distinct: `npm run dev:daemon` / `npm run dev:web`.
// Once Vite is ready it opens the UI in your browser — set HYPERGATE_OPEN=0
// (or CI=1) to skip, e.g. under an automated preview harness.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  { name: 'daemon', color: '\x1b[35m', args: ['run', 'dev:daemon'] },
  { name: 'web', color: '\x1b[36m', args: ['run', 'dev:web'] },
];
const reset = '\x1b[0m';
const children = [];

// Open the web UI in the default browser, once, when Vite reports it's ready.
const noOpen = process.env.HYPERGATE_OPEN === '0' || process.env.CI;
let opened = false;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const openBrowser = (url) => {
  if (opened || noOpen) return;
  opened = true;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best-effort; the URL is printed above regardless */
  }
};

for (const p of procs) {
  const child = spawn(npm, p.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  const tag = `${p.color}[${p.name}]${reset} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        out.write(`${tag}${line}\n`);
        // Vite prints "Local:  http://localhost:5180/" when the dev server is ready.
        if (p.name === 'web' && !opened) {
          const m = stripAnsi(line).match(/Local:\s*(https?:\/\/\S+)/);
          if (m) openBrowser(m[1]);
        }
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${tag}exited (${code})\n`);
    shutdown();
  });
  children.push(child);
}
let down = false;
function shutdown() {
  if (down) return;
  down = true;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
