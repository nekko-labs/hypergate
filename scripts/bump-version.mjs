#!/usr/bin/env node
// Move the release version. Every PR bumps the minor by one (see TASKS.md §4),
// so this exists to make that one command rather than six hand edits that drift.
//
//   node scripts/bump-version.mjs            # minor bump (the default rule)
//   node scripts/bump-version.mjs --patch    # patch, for a fix on a cut release
//   node scripts/bump-version.mjs 0.20.0     # an exact version
//   node scripts/bump-version.mjs --check    # assert every file already agrees
//
// The root package.json is the source of truth; the release workflow checks the
// `v*` tag against it, and everything below has to say the same thing.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Every place the version is written, and how to find it in that file. Adding a
// file here is the whole cost of a new artifact carrying the version.
const SITES = [
  { file: 'package.json', find: /("version":\s*")([^"]+)(")/ },
  { file: 'apps/daemon/package.json', find: /("version":\s*")([^"]+)(")/ },
  // the daemon reports this over /health and compares it against the update feed
  { file: 'apps/daemon/src/index.ts', find: /(const VERSION = ')([^']+)(')/ },
  { file: 'apps/shell/Cargo.toml', find: /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/ },
  { file: 'apps/shell/Cargo.lock', find: /(name = "hypergate-shell"\nversion = ")([^"]+)(")/ },
  { file: '.claude-plugin/marketplace.json', find: /("version":\s*")([^"]+)(")/ },
  { file: 'plugins/hypergate/.claude-plugin/plugin.json', find: /("version":\s*")([^"]+)(")/ },
  // Two occurrences here — the server's own version and the npm package's — and
  // the registry rejects a submission where they disagree, so `all` moves both.
  { file: 'server.json', find: /("version":\s*")([^"]+)(")/g, all: true },
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const current = JSON.parse(read('package.json')).version;
if (!SEMVER.test(current)) throw new Error(`root package.json version is not semver: ${current}`);

const arg = process.argv[2] ?? '--minor';
const [major, minor, patch] = current.match(SEMVER).slice(1).map(Number);
const next =
  arg === '--check' ? current
  : arg === '--minor' ? `${major}.${minor + 1}.0`
  : arg === '--patch' ? `${major}.${minor}.${patch + 1}`
  : arg === '--major' ? `${major + 1}.0.0`
  : arg;

if (!SEMVER.test(next)) {
  console.error(`Not a version: ${next}\nUsage: bump-version.mjs [--minor|--patch|--major|--check|X.Y.Z]`);
  process.exit(2);
}

const stale = [];
for (const { file, find, all } of SITES) {
  const before = read(file);
  // `all` sites carry the version more than once; a global regex also makes
  // String.replace rewrite every occurrence rather than just the first.
  const matches = all ? [...before.matchAll(find)] : [before.match(find)].filter(Boolean);
  if (!matches.length) throw new Error(`${file}: no version to replace (the pattern moved)`);
  const found = matches.map((m) => m[2]);
  if (arg === '--check') {
    for (const v of new Set(found)) if (v !== current) stale.push(`${file}: ${v} (root says ${current})`);
    continue;
  }
  if (found.every((v) => v === next)) {
    console.log(`  = ${file} already ${next}`);
    continue;
  }
  writeFileSync(join(ROOT, file), before.replace(find, `$1${next}$3`));
  console.log(`  ${found.join(', ')} -> ${next}  ${file}`);
}

if (arg === '--check') {
  if (stale.length) {
    console.error(`Version drift:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`All ${SITES.length} files agree on ${current}.`);
} else {
  console.log(`\nv${next}. Add the release row to SPEC.md and the shipped entry to TASKS.md.`);
}
