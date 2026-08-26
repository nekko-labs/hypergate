// Assemble the publishable npm packages into `dist-npm/`.
//
// Two kinds of package come out of here:
//
//   hypergated                       the daemon (one bundled JS file) + the web
//                                    UI + the `hypergate`/`hypergated` bins
//   hypergate-shell-<os>-<arch>      one prebuilt native shell binary each
//
// The split exists because the daemon is portable JavaScript and the shell is
// a native binary: npm's `os`/`cpu` fields let a user's install pull exactly
// one platform build instead of all five. `hypergated` lists them as *optional*
// dependencies, so an unsupported platform still gets a working daemon.
//
//   node scripts/build-npm.mjs                  # main package + this host's shell
//   node scripts/build-npm.mjs --skip-build     # reuse existing build output
//   node scripts/build-npm.mjs --no-shell       # main package only
//   node scripts/build-npm.mjs --shell-only --target linux-x64 --binary <path>
//   node scripts/build-npm.mjs --pack           # also `npm pack` each package
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-npm');
const TEMPLATE = join(ROOT, 'packaging', 'npm');

/** The published name of the main package. `hypergate` on npm is taken by an
 *  unrelated project, so the daemon's own name carries the whole thing; the
 *  installed CLI is still called `hypergate`. */
const PKG = 'hypergated';
/** Every platform we ship a native shell for. `target` is the Rust triple.
 *  macOS is Apple silicon only. */
export const PLATFORMS = [
  { os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc' },
  { os: 'win32', cpu: 'arm64', target: 'aarch64-pc-windows-msvc' },
  { os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin' },
  { os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-gnu' },
  { os: 'linux', cpu: 'arm64', target: 'aarch64-unknown-linux-gnu' },
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// The MCP registry refuses a package whose `mcpName` does not match the `name`
// in server.json, so it is read from there rather than written twice.
const mcpName = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8')).name;
const run = (cmd, cmdArgs, cwd = ROOT) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });

/** Run a Node CLI by its script, never via a `.cmd` shim: spawning one needs
 *  `shell: true`, which concatenates arguments instead of escaping them. */
const runNode = (script, scriptArgs, cwd = ROOT) => run(process.execPath, [script, ...scriptArgs], cwd);

/** npm's own entry script, so `npm run build` needs no shell either. */
function npmCli() {
  const candidates = [
    // npm sets this when it is the one invoking us, and it is right even when
    // the layout below is not (Homebrew keeps npm under the *prefix*, not under
    // the versioned Cellar directory that `node` itself lives in).
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', '..', '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`could not find npm-cli.js near ${process.execPath}`);
  return found;
}
const npm = (npmArgs, cwd = ROOT) => runNode(npmCli(), npmArgs, cwd);

const log = (msg) => console.log(`  ${msg}`);

// ── the main package ─────────────────────────────────────────────────────────

async function buildMain() {
  const dir = join(OUT, PKG);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });

  // One self-contained daemon file. Bundling (rather than depending on
  // @hypergate/core + @hypergate/shared + the MCP SDK) keeps this to a single
  // published package with no install-time dependency tree. The whole point
  // is that a user types one command and has a working gateway.
  //
  // The JS API, not the CLI: on Unix `node_modules/esbuild/bin/esbuild` is the
  // native executable itself, so running it through node is a syntax error.
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [join(ROOT, 'apps/daemon/src/index.ts')],
    outfile: join(dir, 'lib', 'hypergated.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    banner: {
      // Some transitive CommonJS deps (cross-spawn, under the MCP SDK's stdio
      // client) call `require` at runtime. In an ESM bundle esbuild replaces
      // that with a helper that throws unless a real `require` is in scope, so
      // put one there. Without this the daemon dies on its first stdio launch.
      js: 'import { createRequire as __hypergateRequire } from "node:module"; const require = __hypergateRequire(import.meta.url);',
    },
  });

  const web = join(ROOT, 'apps/web/dist');
  if (!existsSync(join(web, 'index.html'))) throw new Error('apps/web/dist is missing, so run `npm run build` first');
  cpSync(web, join(dir, 'web'), { recursive: true });

  for (const bin of ['hypergate.mjs', 'hypergated.mjs']) {
    cpSync(join(TEMPLATE, 'bin', bin), join(dir, 'bin', bin));
    chmodSync(join(dir, 'bin', bin), 0o755);
  }
  cpSync(join(TEMPLATE, 'README.md'), join(dir, 'README.md'));
  cpSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));

  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: PKG,
        version,
        // Ties this package to its MCP registry entry (io.github.nekko-labs/hypergate).
        mcpName,
        description:
          'Hypergate: local-first runtime and manager for MCP servers. Run servers securely, supervise them, and expose one gateway endpoint for any agent harness.',
        keywords: ['mcp', 'model-context-protocol', 'gateway', 'ai', 'agents', 'claude', 'cursor', 'toolhive'],
        homepage: 'https://hypergate.app',
        repository: { type: 'git', url: 'git+https://github.com/nekko-labs/hypergate.git' },
        bugs: { url: 'https://github.com/nekko-labs/hypergate/issues' },
        license: 'MIT',
        author: 'Nekko Labs',
        type: 'module',
        bin: { hypergate: 'bin/hypergate.mjs', hypergated: 'bin/hypergated.mjs' },
        files: ['bin', 'lib', 'web', 'README.md', 'LICENSE'],
        engines: { node: '>=20' },
        // Optional, so an unsupported platform still installs a working daemon
        // instead of failing the whole install.
        optionalDependencies: Object.fromEntries(
          PLATFORMS.map((p) => [`hypergate-shell-${p.os}-${p.cpu}`, version]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  log(`${PKG}@${version} → dist-npm/${PKG}`);
  return dir;
}

// ── one platform's native shell ──────────────────────────────────────────────

function buildShell({ os, cpu, binary }) {
  const platform = PLATFORMS.find((p) => p.os === os && p.cpu === cpu);
  if (!platform) throw new Error(`unknown target ${os}-${cpu}`);
  if (!existsSync(binary)) throw new Error(`no binary at ${binary}, so build it first (npm run shell:build)`);

  const name = `hypergate-shell-${os}-${cpu}`;
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });

  const exe = os === 'win32' ? 'hypergate.exe' : 'hypergate';
  cpSync(binary, join(dir, 'bin', exe));
  if (os !== 'win32') chmodSync(join(dir, 'bin', exe), 0o755);

  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version,
        description: `The Hypergate CLI, tray agent and sandbox launcher for ${os}-${cpu}.`,
        homepage: 'https://hypergate.app',
        repository: { type: 'git', url: 'git+https://github.com/nekko-labs/hypergate.git' },
        license: 'MIT',
        author: 'Nekko Labs',
        // npm refuses to install this package on any other platform, which is
        // what makes it safe for `hypergated` to depend on all five at once.
        os: [os],
        cpu: [cpu],
        files: ['bin'],
        // Deliberately no `bin` field: the `hypergate` command belongs to the
        // main package's shim, and two packages claiming it would collide.
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, 'README.md'),
    `# ${name}\n\nThe native Hypergate shell for ${os}-${cpu}. Installed automatically as an optional dependency of [\`${PKG}\`](https://www.npmjs.com/package/${PKG}); you don't need to install it yourself.\n`,
  );
  cpSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
  log(`${name}@${version} → dist-npm/${name}`);
  return dir;
}

/** Where `cargo build` puts the binary for a target (or the host default). */
function hostBinary(target) {
  const exe = process.platform === 'win32' ? 'hypergate.exe' : 'hypergate';
  const base = join(ROOT, 'apps/shell/target');
  const targeted = join(base, target ?? '', 'release', exe);
  return existsSync(targeted) ? targeted : join(base, 'release', exe);
}

// ── entry point ──────────────────────────────────────────────────────────────

const hostOs = process.platform;
const hostCpu = process.arch;
const built = [];

if (!flag('skip-build') && !flag('shell-only')) {
  console.log('› building workspaces');
  npm(['run', 'build']);
}

console.log('› assembling packages');
if (!flag('shell-only')) built.push(await buildMain());

if (!flag('no-shell')) {
  const targetArg = option('target');
  const [os, cpu] = targetArg ? targetArg.split('-') : [hostOs, hostCpu];
  const platform = PLATFORMS.find((p) => p.os === os && p.cpu === cpu);
  if (!platform) {
    console.error(`  skipping the native shell: ${os}-${cpu} is not one of ${PLATFORMS.map((p) => `${p.os}-${p.cpu}`).join(', ')}`);
  } else {
    // Build unless the caller supplied a binary (the release workflow hands us
    // one per target) or explicitly opted out. Always, not just when it's
    // missing: an existing `target/release/hypergate` from an older commit is
    // exactly the artifact you must never ship, and it looks fine until someone
    // runs `hypergate --version` on the published package.
    const explicit = option('binary');
    if (!explicit && !flag('skip-build')) {
      console.log('› building the native shell');
      run('cargo', ['build', '--release', '--manifest-path', join(ROOT, 'apps/shell/Cargo.toml')]);
    }
    built.push(buildShell({ os, cpu, binary: explicit ?? hostBinary(platform.target) }));
  }
}

if (flag('pack')) {
  console.log('› packing');
  for (const dir of built) npm(['pack', '--pack-destination', OUT], dir);
}

console.log(`\nDone. ${built.length} package(s) in dist-npm/.`);
console.log(`Publish with: npm publish dist-npm/<package> --access public`);
