import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('shared Claude Code settings suppress default commit and PR attribution', () => {
  const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  assert.equal(settings.attribution?.commit, '');
  assert.equal(settings.attribution?.pr, '');
  assert.equal(settings.attribution?.sessionUrl, false);
});
