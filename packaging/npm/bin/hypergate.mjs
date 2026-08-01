#!/usr/bin/env node
// The `hypergate` command, as installed from npm.
//
// The CLI, tray agent and sandbox launcher are one native binary (Rust: it needs
// tray, keychain, login-item and Job Object APIs). npm can't ship a binary for
// every platform in one package, so each build lives in its own optional
// dependency and this shim picks the one that matches the machine, exactly the
// way esbuild and swc do it.
//
// The shim also tells the binary how to start the daemon that ships beside it,
// so a user never has to know there are two processes involved.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const exe = process.platform === 'win32' ? 'hypergate.exe' : 'hypergate';

/** Which optional dependency holds this machine's build. */
const pkgName = `hypergate-shell-${process.platform}-${process.arch}`;

function findBinary() {
  // An explicit override wins: it's how the repo's own smoke tests run a
  // freshly built binary against a packaged daemon.
  if (process.env.HYPERGATE_SHELL && existsSync(process.env.HYPERGATE_SHELL)) {
    return process.env.HYPERGATE_SHELL;
  }
  try {
    // resolve() the package's own manifest: the binary is not a module, so it
    // can't be resolved directly, and this works regardless of whether npm
    // hoisted the dependency or nested it.
    return join(dirname(require.resolve(`${pkgName}/package.json`)), 'bin', exe);
  } catch {
    return undefined;
  }
}

const binary = findBinary();
if (!binary || !existsSync(binary)) {
  console.error(
    `hypergate: no native binary for ${process.platform}-${process.arch}.\n\n` +
      `The CLI ships as a per-platform optional dependency (${pkgName}).\n` +
      `If your installer skipped optional dependencies, reinstall with:\n` +
      `  npm install -g hypergated --include=optional\n\n` +
      `The daemon itself is pure JavaScript and still works: run \`hypergated\`,\n` +
      `then open http://localhost:7777 to manage your servers in the browser.`,
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    // JSON, not a command line: the install path routinely contains spaces
    // (`C:\Program Files\…`, `~/Library/Application Support/…`).
    HYPERGATE_DAEMON_CMD:
      process.env.HYPERGATE_DAEMON_CMD ?? JSON.stringify([process.execPath, join(here, 'hypergated.mjs')]),
  },
});
child.on('error', (err) => {
  console.error(`hypergate: could not run ${binary}: ${err.message}`);
  process.exit(1);
});
// Mirror the child exactly, signal included, so scripts and `&&` chains behave.
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
