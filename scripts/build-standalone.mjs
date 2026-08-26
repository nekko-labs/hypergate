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
//   node scripts/build-standalone.mjs --node <path-to-node-binary>
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// npm's own entry script, so `npm run build` needs no shell. `npm_execpath` is
// checked first because it is set by whichever npm invoked us and is correct
// even where the layouts below are not: Homebrew keeps npm under the *prefix*,
// not under the versioned Cellar directory `node` itself lives in.
const npmCli = () =>
  [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', '..', '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
    .filter(Boolean)
    .find(existsSync);

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

function seaBinary(mainScript, baseBinary = process.execPath) {
  if (!existsSync(baseBinary)) {
    throw new Error(`no Node binary at ${baseBinary}, so provide a valid \`--node\` path`);
  }
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
        // a process that runs for days. With both disabled, this blob carries
        // no machine code and can be injected into a target-architecture Node
        // base selected with --node.
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ['--experimental-sea-config', config]);

  const target = join(OUT, `hypergated${EXE}`);
  copyFileSync(baseBinary, target);
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

// ── is this Node fit to build a release with? ─────────────────────────────────
//
// Two different Node binaries, two different requirements, and getting either
// wrong fails in a way that is easy to misread.
//
//   1. **The generator** (`process.execPath`) writes the SEA blob, so it needs
//      single-executable support compiled in. Homebrew's Node does not have it:
//      the formula passes `--disable-single-executable-application` because the
//      feature is incompatible with its `--shared` build
//      (nodejs/node#63126). No Homebrew version will ever work, so "update Node"
//      is the wrong advice; an official build is the right one.
//   2. **The base** (`--node`, defaulting to `process.execPath`) is copied and
//      becomes the `hypergated` we ship, so it has to run on machines that are
//      not this one. Homebrew's Node links 21 dylibs under /opt/homebrew, none
//      of which a user has.
//
// The second check matters more than the first, because a shared-build Node
// with SEA *enabled* would sail through and silently produce an installer that
// only works on the machine that built it. CI is unaffected either way:
// actions/setup-node installs official builds.

/**
 * Libraries a binary needs from outside the OS's own directories.
 *
 * Parsed from the linker's own columns rather than by scraping anything that
 * looks like a path: `otool` prints each dependency as `<name> (compatibility
 * ...)`, and `ldd` as `<soname> => <resolved path>`. Scraping instead turns
 * `@rpath/libnode.dylib` into `/libnode.dylib`, which reads like a system path
 * and is not one.
 */
function foreignLibs(exe) {
  const system = process.platform === 'darwin' ? [/^\/usr\/lib\//, /^\/System\//] : [/^\/lib/, /^\/usr\/lib/];
  let out;
  try {
    out =
      process.platform === 'darwin'
        ? execFileSync('otool', ['-L', exe], { encoding: 'utf8' })
        : execFileSync('ldd', [exe], { encoding: 'utf8' });
  } catch {
    return []; // no otool/ldd: cannot tell, and guessing would block a good build
  }
  const deps =
    process.platform === 'darwin'
      ? [...out.matchAll(/^\s+(\S+)\s+\(compatibility/gm)].map((m) => m[1])
      : [...out.matchAll(/=>\s+(\/\S+)/g)].map((m) => m[1]);
  // An @rpath/@loader_path dependency is by definition not a system library.
  return deps.filter((lib) => !system.some((re) => re.test(lib)));
}

/** Does this Node have single-executable support compiled in? */
function seaCapable(exe) {
  try {
    const out = execFileSync(exe, ['-p', 'process.config.variables.single_executable_application'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** Node installs that are official builds rather than a distro's shared one. */
function candidateNodes() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const roots = [
    join(home, '.local/share/fnm/node-versions'),
    join(home, 'Library/Application Support/fnm/node-versions'),
    join(home, '.fnm/node-versions'),
    join(home, '.nvm/versions/node'),
    join(home, '.volta/tools/image/node'),
    join(home, '.asdf/installs/nodejs'),
  ];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Newest version first, so a build picks up the most current official Node.
    for (const entry of readdirSync(root).sort().reverse()) {
      for (const rel of ['bin/node', 'installation/bin/node', `bin/node${EXE}`]) {
        const candidate = join(root, entry, ...rel.split('/'));
        if (existsSync(candidate)) found.push(candidate);
      }
    }
  }
  for (const fixed of ['/usr/local/bin/node', 'C:\\Program Files\\nodejs\\node.exe']) {
    if (existsSync(fixed)) found.push(fixed);
  }
  return found;
}

/** A Node that can both generate the blob and be shipped, or undefined. */
function findUsableNode() {
  const explicit = process.env.HYPERGATE_BUILD_NODE;
  const list = explicit ? [explicit, ...candidateNodes()] : candidateNodes();
  return list.find((exe) => existsSync(exe) && seaCapable(exe) && foreignLibs(exe).length === 0);
}

/**
 * Refuse to build a release with a Node that cannot produce one, recovering
 * automatically when a usable Node is installed. Windows Node is self-contained
 * and ships SEA, so this only ever engages on macOS and Linux.
 */
function requireShippableNode() {
  if (process.env.HYPERGATE_NODE_CHECKED === '1' || process.platform === 'win32') return;
  const base = option('node') ?? process.execPath;
  const problems = [];
  if (!seaCapable(process.execPath)) problems.push('it has no single-executable support compiled in');
  const foreign = foreignLibs(base);
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 3).join(', ');
    problems.push(
      `the binary it would ship links ${foreign.length} librar${foreign.length === 1 ? 'y' : 'ies'} that exist only on this machine (${shown}${foreign.length > 3 ? ', …' : ''})`,
    );
  }
  if (problems.length === 0) return;

  const better = findUsableNode();
  if (better) {
    console.log(`› ${process.execPath} cannot build a distributable release, so using ${better}`);
    run(better, [fileURLToPath(import.meta.url), ...args], { env: { ...process.env, HYPERGATE_NODE_CHECKED: '1' } });
    process.exit(0);
  }
  // Printed rather than thrown: this is a machine-configuration problem with a
  // known remedy, and a stack trace through the build script only buries it.
  console.error(
    [
      '',
      `${process.execPath} cannot build a release that runs anywhere else:`,
      ...problems.map((p) => `  - ${p}`),
      '',
      'This is not about the Node version. Homebrew builds Node against shared',
      'libraries and disables single-executable support for that reason, so no',
      'Homebrew Node of any version can produce a distributable binary.',
      '',
      'Install an official build (nodejs.org, or fnm/nvm/volta, current version is',
      'fine) and this script will find and use it, or point at one directly:',
      '',
      '  HYPERGATE_BUILD_NODE=/path/to/official/node npm run build:standalone',
      '',
      'CI is unaffected: actions/setup-node installs official builds already.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// ── entry point ──────────────────────────────────────────────────────────────

requireShippableNode();

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
const daemon = seaBinary(main, option('node'));

console.log('› collecting the payload');
payload(option('shell') ?? join(ROOT, 'apps/shell/target/release', `hypergate${EXE}`));

rmSync(WORK, { recursive: true, force: true });

const mb = (p) => `${(readFileSync(p).length / 1024 / 1024).toFixed(1)}MB`;
console.log(`\nHypergate ${version} install tree in dist-standalone/`);
console.log(`  hypergated${EXE}  ${mb(daemon)} (no Node required)`);
if (!flag('daemon-only')) console.log(`  hypergate${EXE}   ${mb(join(OUT, `hypergate${EXE}`))}`);
