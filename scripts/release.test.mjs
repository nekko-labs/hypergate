import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compare, newestTag, nextVersion, previousTag } from './nightly-version.mjs';
import { mergeFragments, titlesFromLog } from './release-fragments.mjs';

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

test('the newest tag is compared numerically, ignoring short and odd tags', () => {
  assert.equal(newestTag(['v1.9.0', 'v1.10.0', 'v1.38', 'v1.37.2', 'nightly', 'v2.0.0-rc.1']), 'v1.37.2');
  assert.equal(compare('1.10.0', '1.9.9') > 0, true);
  assert.equal(newestTag([]), null);
});

test('a nightly is the next patch on the newest line', () => {
  assert.equal(nextVersion({ tags: ['v1.37.0', 'v1.38.0'], committed: '1.38.0' }), '1.38.1');
  assert.equal(nextVersion({ tags: ['v1.38.0', 'v1.38.4'], committed: '1.38.0' }), '1.38.5');
  // A short tag starts a line; version-release.yml adds its .0 tag.
  assert.equal(nextVersion({ tags: ['v1.38.4', 'v1.39', 'v1.39.0'], committed: '1.38.0' }), '1.39.1');
});

test('a committed version above every tag is released as it is', () => {
  // The last bump-per-PR merge (1.38.0) lands untagged: the nightly releases it.
  assert.equal(nextVersion({ tags: ['v1.37.0'], committed: '1.38.0' }), '1.38.0');
  assert.equal(nextVersion({ tags: [], committed: '0.1.0' }), '0.1.0');
});

test('note files merge by section, in the README order', () => {
  const notes = mergeFragments([
    '### Bug fixes\n\n- **Links work.** They opened nothing.\n',
    '# Stray title\n\n### Features\n\n- **A chip.** It stands out.\n\n### Bug fixes\n\n- **Logs scroll.** They jumped.',
    '- **No heading.** Still listed.',
  ]);
  assert.equal(notes, [
    '### Features\n\n- **A chip.** It stands out.',
    '### Bug fixes\n\n- **Links work.** They opened nothing.\n- **Logs scroll.** They jumped.',
    '### Changes\n\n- **No heading.** Still listed.',
  ].join('\n\n'));
  assert.equal(mergeFragments([]), '');
});

test('with no note files, the night lists its PR titles', () => {
  const log = [
    'Merge pull request #137 from nekko-labs/feat/tag\x1fTag Nekko Labs servers\n\nbody\x1e',
    'Fix a typo\x1f\x1e',
    "Merge branch 'main' into x\x1f\x1e",
  ].join('\n');
  assert.deepEqual(titlesFromLog(log), ['Tag Nekko Labs servers (#137)', 'Fix a typo']);
});

test('the nightly tags and dispatches; nothing releases on a package.json change any more', () => {
  const nightly = workflow('nightly-release.yml');
  assert.match(nightly, /schedule:/);
  assert.match(nightly, /nightly-version\.mjs/);
  assert.match(nightly, /gh workflow run release\.yml --ref "\$TAG"/);
  const version = workflow('version-release.yml');
  assert.doesNotMatch(version, /paths:[\s\S]*'package\.json'/);
  assert.match(version, /v\[0-9\]\+\.\[0-9\]\+'/);
});

test('releases stamp the version from the tag instead of requiring it committed', () => {
  assert.doesNotMatch(workflow('release.yml'), /does not match package.json/);
  assert.match(workflow('release.yml'), /bump-version\.mjs "\$version"/);
  assert.match(workflow('build-artifacts.yml'), /bump-version\.mjs "\$version"/);
});

test('the previous release counts tags on the same commit, so a new line on a shipped nightly repeats nothing', () => {
  // v1.39.0 starts on the commit v1.38.2 shipped: its notes run from v1.38.2.
  assert.equal(previousTag('v1.39.0', ['v1.38.1', 'v1.38.2', 'v1.39', 'v1.39.0']), 'v1.38.2');
  assert.equal(previousTag('v1.38.3', ['v1.38.2', 'v1.38.3']), 'v1.38.2');
  assert.equal(previousTag('v1.0.0', ['v1.0.0']), null);
});

test('the shell lockfile version is found with LF and CRLF line endings', async () => {
  const src = readFileSync(new URL('./bump-version.mjs', import.meta.url), 'utf8');
  const find = new RegExp(/Cargo\.lock', find: \/(.+)\/ \}/.exec(src)[1]);
  for (const eol of ['\n', '\r\n']) {
    const lock = `[[package]]${eol}name = "hypergate-shell"${eol}version = "1.37.0"${eol}`;
    assert.equal(lock.replace(find, '$11.38.1$3'), lock.replace('1.37.0', '1.38.1'), JSON.stringify(eol));
  }
});
