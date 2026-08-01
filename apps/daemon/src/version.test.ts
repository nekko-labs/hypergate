import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One release, one number.
 *
 * The version a running daemon reports is a literal in `index.ts`, because the
 * daemon ships as a single bundled file (and as a SEA executable) with no
 * package.json beside it to read at runtime. That literal has already gone
 * stale once: a 0.13.0 build served `/health` claiming 0.12.0, which is exactly
 * the number the update check compares against, so an out-of-date daemon would
 * have offered an update to a version it was already running.
 *
 * These are all the places the release number lives. If a bump misses one, this
 * fails here rather than in a user's update banner.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const json = (...parts: string[]): { version?: string } => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));

describe('release version', () => {
  const expected = json('package.json').version;

  it('is a real version to begin with', () => {
    expect(expected).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('matches the daemon package', () => {
    expect(json('apps', 'daemon', 'package.json').version).toBe(expected);
  });

  it('matches the literal the daemon reports at runtime', () => {
    const source = readFileSync(join(ROOT, 'apps', 'daemon', 'src', 'index.ts'), 'utf8');
    const literal = /^const VERSION = '([^']+)';$/m.exec(source)?.[1];
    expect(literal).toBe(expected);
  });

  it('matches the shell binary, which is what `hypergate --version` prints', () => {
    const cargo = readFileSync(join(ROOT, 'apps', 'shell', 'Cargo.toml'), 'utf8');
    // The first `version =` in the file is the `[package]` one; dependency
    // versions come later, under their own tables.
    const literal = /^version = "([^"]+)"$/m.exec(cargo)?.[1];
    expect(literal).toBe(expected);
  });
});
