// Assemble the install tree: Hypergate with no Node runtime required.
//
// `npm install -g hypergated` is fine for people who already have Node. An
// installer is for everyone else, which means the daemon has to stop being a
// script. Node's Single Executable Application support does that: the esbuild
// bundle is injected into a copy of the Node binary, producing one file that
// needs nothing installed.
//
// Node SEA rather than `bun build --compile`, which would be less work and
// cross-compiles: Bun has no `node:sqlite`, so a Bun build silently loses the
// durable usage history and server logs (`openStore` returns undefined and the
// daemon degrades to in-memory analytics). Shipping that quietly would be worse
// than the extra CI machinery.
//
// The output is one directory that all three installers package verbatim:
//
//   dist-standalone/
//     hypergate[.exe]     the CLI, tray agent and sandbox launcher (Rust)
//     hypergated[.exe]    the daemon (SEA)
//     web/                the manager UI the daemon serves
//     LICENSE  README.md
//
//   node scripts/build-standalone.mjs              # build everything
//   node scripts/build-standalone.mjs --skip-build # reuse existing output
//   node scripts/build-standalone.mjs --shell <path-to-hypergate-binary>
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-standalone');
const WORK = join(OUT, '.build');
const EXE = process.platform === 'win32' ? '.exe' : '';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const option = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', ...opts });
const runNode = (script, scriptArgs) => run(process.execPath, [script, ...scriptArgs]);
const quiet = (cmd, cmdArgs) => {
  try {
    execFileSync(cmd, cmdArgs, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const npmCli = () =>
  [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(existsSync);

// ── 1. bundle the daemon as CommonJS ─────────────────────────────────────────

async function bundle() {
  mkdirSync(WORK, { recursive: true });
  const outfile = join(WORK, 'hypergated.cjs');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [join(ROOT, 'apps/daemon/src/index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    // CommonJS, because a SEA main script must be CJS. That costs us
    // `import.meta.url`, which the daemon and the store both use, so define it
    // as the CJS equivalent rather than letting esbuild leave it empty.
    format: 'cjs',
    target: 'node22',
    legalComments: 'none',
    define: { 'import.meta.url': '__hypergateModuleUrl' },
    banner: {
      js: "const __hypergateModuleUrl = require('node:url').pathToFileURL(__filename).href;",
    },
  });
  return outfile;
}

// ── 2. inject it into a copy of the Node binary ──────────────────────────────

function seaBinary(mainScript) {
  const config = join(WORK, 'sea-config.json');
  const blob = join(WORK, 'hypergated.blob');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        main: mainScript,
        output: blob,
        // The warning would otherwise print on every daemon start.
        disableExperimentalSEAWarning: true,
        // No snapshot and no code cache: both tie the artifact to the exact
        // Node build that produced it, and buy startup time we do not need for
        // a process that runs for days.
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ['--experimental-sea-config', config]);

  const target = join(OUT, `hypergated${EXE}`);
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);

  // A signature over the original Node binary cannot survive us appending to
  // it. Strip it first where we can, so the result is cleanly unsigned rather
  // than signed-and-invalid, which is the worse of the two for SmartScreen and
  // outright fatal to Gatekeeper on arm64 Macs.
  if (process.platform === 'win32') {
    if (!quiet('signtool', ['remove', '/s', target])) {
      console.log('  note: signtool not found, leaving the Node signature to be invalidated');
    }
  }
  if (process.platform === 'darwin') {
    quiet('codesign', ['--remove-signature', target]);
  }

  const postject = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!existsSync(postject)) throw new Error('postject is not installed, so run `npm install` first');
  runNode(postject, [
    target,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ]);

  // macOS refuses to execute a binary with no signature at all on Apple
  // silicon. Ad-hoc signing is enough to run; a real Developer ID signature is
  // applied later, at release time.
  if (process.platform === 'darwin') {
    quiet('codesign', ['--sign', '-', target]);
  }
  return target;
}

// ── 3. everything else the install tree needs ────────────────────────────────

function payload(shellBinary) {
  const web = join(ROOT, 'apps/web/dist');
  if (!existsSync(join(web, 'index.html'))) throw new Error('apps/web/dist is missing, so run `npm run build` first');
  cpSync(web, join(OUT, 'web'), { recursive: true });

  // `--daemon-only` skips the Rust half, so CI can guard the fragile part (the
  // SEA build, which breaks on anything the CommonJS bundle cannot express)
  // without paying for a release-mode cargo build and its GTK dependencies.
  if (flag('daemon-only')) {
    for (const doc of ['LICENSE', 'README.md']) copyFileSync(join(ROOT, doc), join(OUT, doc));
    return;
  }
  if (!existsSync(shellBinary)) {
    throw new Error(`no shell binary at ${shellBinary}, so build it first (npm run shell:build)`);
  }
  const shellTarget = join(OUT, `hypergate${EXE}`);
  copyFileSync(shellBinary, shellTarget);
  chmodSync(shellTarget, 0o755);

  for (const doc of ['LICENSE', 'README.md']) {
    copyFileSync(join(ROOT, doc), join(OUT, doc));
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

if (!flag('skip-build')) {
  console.log('› building workspaces');
  runNode(npmCli(), ['run', 'build']);
  if (!flag('daemon-only')) {
    console.log('› building the native shell');
    run('cargo', ['build', '--release', '--manifest-path', join(ROOT, 'apps/shell/Cargo.toml')]);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('› bundling the daemon');
const main = await bundle();

console.log('› building the standalone daemon');
const daemon = seaBinary(main);

console.log('› collecting the payload');
payload(option('shell') ?? join(ROOT, 'apps/shell/target/release', `hypergate${EXE}`));

rmSync(WORK, { recursive: true, force: true });

const mb = (p) => `${(readFileSync(p).length / 1024 / 1024).toFixed(1)}MB`;
console.log(`\nHypergate ${version} install tree in dist-standalone/`);
console.log(`  hypergated${EXE}  ${mb(daemon)} (no Node required)`);
if (!flag('daemon-only')) console.log(`  hypergate${EXE}   ${mb(join(OUT, `hypergate${EXE}`))}`);
