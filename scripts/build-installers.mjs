// Build the native installer for whichever platform this is running on.
//
// Each installer is built on its own OS, on purpose. Cross-building a Windows
// installer from Linux is possible (makensis runs there), but then the icon,
// the version resource and the shortcut code would all have to be produced by a
// binary that cannot run on the build machine. Native builds keep every artifact
// made by the same toolchain that will execute it.
//
// Consumes the tree from `build-standalone.mjs` and writes to dist-installers/.
//
//   node scripts/build-installers.mjs                 # build the payload, then the installer
//   node scripts/build-installers.mjs --skip-payload  # reuse dist-standalone/
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD = join(ROOT, 'dist-standalone');
const OUT = join(ROOT, 'dist-installers');
const INSTALLERS = join(ROOT, 'packaging', 'installers');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', ...opts });

/** npm's `arch` vocabulary, which is what the release assets are named with. */
const buildTarget = process.env.HYPERGATE_BUILD_TARGET;
const ARCH = buildTarget ? (buildTarget.includes('aarch64') ? 'arm64' : 'x64') : process.arch === 'arm64' ? 'arm64' : 'x64';

if (!flag('skip-payload')) {
  run(process.execPath, [join(ROOT, 'scripts', 'build-standalone.mjs'), ...(flag('skip-build') ? ['--skip-build'] : [])]);
}

const exe = process.platform === 'win32' ? '.exe' : '';
for (const required of [`hypergate${exe}`, `hypergated${exe}`, join('web', 'index.html')]) {
  if (!existsSync(join(PAYLOAD, required))) {
    throw new Error(`dist-standalone/${required} is missing, so run \`npm run build:standalone\` first`);
  }
}
mkdirSync(OUT, { recursive: true });

function windows() {
  const makensis = ['makensis', 'makensis.exe'].find((c) => {
    try {
      execFileSync(c, ['/VERSION'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!makensis) {
    throw new Error(
      'makensis is not on PATH. Install NSIS (winget install NSIS.NSIS, or choco install nsis) and try again.',
    );
  }

  // The installer's own icon comes from the binary we just built, so it can
  // never disagree with the tray icon or the shortcut icon.
  const icon = join(PAYLOAD, 'hypergate.ico');
  run(join(PAYLOAD, 'hypergate.exe'), ['icon', icon]);

  const output = join(OUT, `hypergate-${version}-windows-${ARCH}-setup.exe`);
  run(makensis, [
    '/V2',
    `/DVERSION=${version}`,
    `/DARCH=${ARCH}`,
    `/DPAYLOAD=${PAYLOAD}`,
    `/DICON=${icon}`,
    `/DPATHSCRIPT=${join(INSTALLERS, 'windows', 'path.ps1')}`,
    `/DOUTFILE=${output}`,
    join(INSTALLERS, 'windows', 'hypergate.nsi'),
  ]);
  return [output];
}

function macos() {
  const output = join(OUT, `hypergate-${version}-macos-${ARCH}.pkg`);
  // Apple's own vocabulary for the architecture, not npm's.
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  run('bash', [join(INSTALLERS, 'macos', 'build-pkg.sh'), PAYLOAD, version, hostArch, output]);
  return [output];
}

function linux() {
  const debArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const before = new Set(readdirSync(OUT));
  run('bash', [join(INSTALLERS, 'linux', 'build-linux.sh'), PAYLOAD, version, debArch, OUT]);
  return readdirSync(OUT)
    .filter((f) => !before.has(f))
    .map((f) => join(OUT, f));
}

const builders = { win32: windows, darwin: macos, linux };
const build = builders[process.platform];
if (!build) throw new Error(`no installer defined for ${process.platform}`);

const built = build();
console.log(`\nHypergate ${version} installers in dist-installers/`);
for (const file of built) {
  console.log(`  ${file.slice(OUT.length + 1)}  ${(statSync(file).size / 1024 / 1024).toFixed(1)}MB`);
}
