import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { renderReleaseHighlights } from './release-highlights.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const releases = JSON.parse(read('./release-highlights.json'));
const template = read('../release-notes.html');
const render = (data = releases) => renderReleaseHighlights(template, data);

test('generates one indexed milestone per release with full notes and credited changes', () => {
  const html = render();
  assert.doesNotMatch(html, /<!-- release-(index|highlights) -->/);
  for (const { tag, date, contributors, features, changes = [] } of releases) {
    assert.equal(html.split(`id="${tag}"`).length, 2);
    assert.ok(html.includes(`href="#${tag}"`));
    const section = html.split(`id="${tag}"`)[1].split('</article>')[0];
    assert.ok(section.includes(`datetime="${date}"`));
    assert.ok(section.includes(`/releases/tag/${tag}"`));
    for (const login of contributors) assert.ok(section.includes(`href="https://github.com/${login}"`));
    for (const { pr } of [...features, ...changes]) assert.ok(section.includes(`/pull/${pr}"`));
  }
  assert.equal((html.match(/Newest highlight/g) || []).length, 1);
  assert.ok(html.includes('id="release-archive"'));
});

test('includes static highlights in the Vite production artifact', async () => {
  const result = await build({
    root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'silent',
    build: { write: false },
  });
  const artifacts = [result].flat().flatMap(({ output }) => output);
  const releasePage = artifacts.find(({ fileName }) => fileName === 'release-notes.html');
  assert.equal(typeof releasePage?.source, 'string');
  assert.doesNotMatch(releasePage.source, /<!-- release-(index|highlights) -->/);
  assert.equal((releasePage.source.match(/class="highlight-release"/g) ?? []).length, releases.length);
  assert.ok(releasePage.source.includes('id="release-archive"'));
  for (const { tag, contributors } of releases) {
    assert.ok(releasePage.source.includes(`href="#${tag}"`));
    assert.ok(releasePage.source.includes(`id="${tag}"`));
    for (const login of contributors) assert.ok(releasePage.source.includes(`href="https://github.com/${login}"`));
  }
});

test('keeps curated text escaped and does not request GitHub avatars', () => {
  const data = structuredClone(releases);
  data[0].title = '<script>alert(1)</script> & "title"';
  const html = render(data);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;title&quot;/);
  assert.doesNotMatch(html, /<img[^>]+src="https?:/);
});

test('rejects malformed editorial data rather than publishing broken credits or dates', () => {
  for (const [change, message] of [
    [(a) => { a[0].features = []; }, /headliner/],
    [(a) => { a[0].features[0].detail = ' '; }, /description/],
    [(a) => { a[0].contributors.push('Ermish'); }, /unique contributor/],
    [(a) => { a[0].contributors[0] = 'bad/profile'; }, /contributor logins/],
    [(a) => { a[0].features[0].authors = ['someone-else']; }, /credited authors/],
    [(a) => { a[0].features[0].pr = 0; }, /PR number/],
    [(a) => { a[0].date = '2026-11-31'; }, /valid UTC/],
    [(a) => { a.reverse(); }, /newest first/],
    [(a) => { a[1].tag = a[0].tag; }, /unique stable release tag/],
  ]) {
    const data = structuredClone(releases);
    change(data);
    assert.throws(() => render(data), message);
  }
});
