// Assemble the Claude Desktop extension (`dist-mcpb/hypergate.mcpb`).
//
// An MCPB bundle is a zip of a `manifest.json` plus a local MCP server, which
// Claude Desktop installs by double-click. Ours carries the same daemon bundle
// the npm package ships, launched with `--stdio`: with a Hypergate daemon
// already running it proxies to that one (so Desktop shares the machine's fleet
// of servers rather than starting a second copy), and without one it runs the
// enabled servers itself.
//
//   node scripts/build-mcpb.mjs                # build workspaces, then pack
//   node scripts/build-mcpb.mjs --skip-build   # reuse existing build output
//   node scripts/build-mcpb.mjs --no-pack      # leave the staged directory only
//   node scripts/build-mcpb.mjs --sign         # also sign (see docs/signing.md)
//   node scripts/build-mcpb.mjs --self-signed  # sign with a throwaway cert, local checks only
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-mcpb');
const STAGE = join(OUT, 'hypergate');
const TEMPLATE = join(ROOT, 'packaging', 'mcpb');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const run = (cmd, cmdArgs, cwd = ROOT) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
const runNode = (script, scriptArgs, cwd = ROOT) => run(process.execPath, [script, ...scriptArgs], cwd);

/** npm's own entry script, so a build needs no shell. Same trick as build-npm. */
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

if (!flag('skip-build')) {
  console.log('› building workspaces');
  runNode(npmCli(), ['run', 'build']);
}

console.log('› staging the bundle');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'server'), { recursive: true });

// The same single-file daemon the npm package publishes, for the same reason:
// a bundle has no install step, so nothing may be resolved from node_modules at
// runtime. The `require` banner is what keeps the MCP SDK's CommonJS
// dependencies working inside an ESM bundle (see build-npm.mjs).
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [join(ROOT, 'apps/daemon/src/index.ts')],
  outfile: join(STAGE, 'server', 'hypergated.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  banner: {
    js: 'import { createRequire as __hypergateRequire } from "node:module"; const require = __hypergateRequire(import.meta.url);',
  },
});

// The manifest is a template so the version is never hand-maintained in two
// places; everything else about it is reviewed material, not generated.
const manifest = JSON.parse(readFileSync(join(TEMPLATE, 'manifest.json'), 'utf8'));
manifest.version = version;
writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(ROOT, 'README.md'), join(STAGE, 'README.md'));
cpSync(join(ROOT, 'PRIVACY.md'), join(STAGE, 'PRIVACY.md'));
cpSync(join(ROOT, 'LICENSE'), join(STAGE, 'LICENSE'));

// The listing icon. A bundle has no network at install time, so the manifest's
// `icon`/`icons` have to resolve inside the archive — and the directory
// submission form wants one. Both sizes come from the same gate mark the site
// and the PWA use, so there is one source of truth for the logo.
cpSync(join(ROOT, 'apps/site/public/icon-512.png'), join(STAGE, 'icon.png'));
cpSync(join(ROOT, 'apps/site/public/icon-192.png'), join(STAGE, 'icon-192.png'));

if (flag('no-pack')) {
  console.log(`\nStaged at dist-mcpb/hypergate (not packed).`);
  process.exit(0);
}

console.log('› packing');
// The official packer, so the archive layout and the manifest schema are
// whatever Claude Desktop expects today rather than what we inferred once.
const mcpbCli = join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
if (!existsSync(mcpbCli)) throw new Error('@anthropic-ai/mcpb is missing, so run `npm install` first');
const bundle = join(OUT, 'hypergate.mcpb');
runNode(mcpbCli, ['pack', STAGE, bundle]);

// Signing, on the same secret-gated terms as every other artifact (see
// docs/signing.md): sign when a cert and key are configured, say so plainly
// when they are not, and never pretend an unsigned bundle is signed. Desktop
// installs an unsigned bundle behind an "unverified" warning, so this is what
// stands between a listing-ready artifact and one that scares the installer.
const signing = { cert: process.env.MCPB_SIGNING_CERT, key: process.env.MCPB_SIGNING_KEY };

/**
 * Assert the bundle really carries a signature, by the marker `mcpb sign`
 * appends after the zip data.
 *
 * Deliberately not `mcpb verify`: as of @anthropic-ai/mcpb 2.1.2 (the latest)
 * `verify` reports "Extension is not signed" for a bundle its own `sign` just
 * wrote — reproducible on a minimal two-file bundle, so it is the tool and not
 * our archive. Gating the build on it would fail every signed release. This
 * checks the one thing we can check honestly: that signing changed the file and
 * left its marker. Swap this for `verify` once upstream can read its own output.
 */
const assertSigned = () => {
  const tail = readFileSync(bundle).subarray(-4096).toString('latin1');
  if (!tail.includes('MCPB_SIG_END')) throw new Error('signing reported success but left no signature block');
  console.log('› signature block present');
};

if (flag('self-signed')) {
  console.log('› signing (self-signed — local check only, not for release)');
  runNode(mcpbCli, ['sign', '--self-signed', bundle]);
  assertSigned();
} else if (flag('sign')) {
  if (!signing.cert || !signing.key) {
    throw new Error(
      '--sign needs MCPB_SIGNING_CERT and MCPB_SIGNING_KEY (PEM paths). Use --self-signed for a local check.',
    );
  }
  console.log('› signing');
  runNode(mcpbCli, ['sign', '--cert', signing.cert, '--key', signing.key, bundle]);
  assertSigned();
} else {
  console.log('› not signed (pass --sign with MCPB_SIGNING_CERT/_KEY, or --self-signed for a local check)');
}

console.log(`\nDone. dist-mcpb/hypergate.mcpb (v${version})`);
console.log('Install it by opening the file with Claude Desktop, or via Settings → Extensions.');
