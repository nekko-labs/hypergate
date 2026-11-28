#!/usr/bin/env node
// The version the nightly release cuts. PRs no longer bump the version (TASKS.md
// §4.1): the nightly reads it from the tags instead.
//
// - MAJOR.MINOR come from the newest release tag `vMAJOR.MINOR.PATCH`. A person
//   starts a new line by pushing the short tag `vMAJOR.MINOR`
//   (version-release.yml turns it into `vMAJOR.MINOR.0` and releases it).
// - Each nightly is the next PATCH on that line: v1.38.0, then v1.38.1, v1.38.2.
// - The version committed in package.json is only a floor. If a PR sets it
//   above every tag (on Philip's ask), the nightly releases exactly that.
//
//   node scripts/nightly-version.mjs          # prints the next version, e.g. 1.38.1
//   node scripts/nightly-version.mjs --last   # prints the newest release tag, e.g. v1.38.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] for a plain release version or tag, else null. */
export function parse(version) {
  const m = SEMVER.exec(version?.trim() ?? '');
  return m ? m.slice(1).map(Number) : null;
}

export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The newest `vX.Y.Z` among the tags. Short tags and anything else are ignored. */
export function newestTag(tags) {
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(compare).at(-1) ?? null;
}

/** The next nightly version, from the release tags and the committed package.json version. */
export function nextVersion({ tags, committed }) {
  const last = newestTag(tags);
  if (!last) return committed;
  if (parse(committed) && compare(committed, last) > 0) return committed;
  const [major, minor, patch] = parse(last);
  return `${major}.${minor}.${patch + 1}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (process.argv.includes('--last')) {
    console.log(newestTag(tags) ?? '');
  } else {
    const committed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    console.log(nextVersion({ tags, committed }));
  }
}
