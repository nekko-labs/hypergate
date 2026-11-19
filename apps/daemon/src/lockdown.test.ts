import { describe, it, expect } from 'vitest';
import { presenceGate, programPathError, runReason } from './lockdown.ts';
import type { AuthorizeVerdict } from './shell.ts';

const gate = (verdict: AuthorizeVerdict) => {
  const refusals: string[] = [];
  const reasons: string[] = [];
  const check = presenceGate({
    authorize: async (reason) => {
      reasons.push(reason);
      return verdict;
    },
    recordRefusal: (tool, client, error) => refusals.push(`${tool}|${client}|${error}`),
  });
  return { check, refusals, reasons };
};

describe('presence gate', () => {
  it('lets a confirmed person through as approved', async () => {
    const { check, refusals, reasons } = gate({ authorized: true });
    expect(await check('turn off credential lockdown', 'lockdown_off', 'manager UI')).toEqual({ ok: true, consent: 'approved' });
    expect(reasons).toEqual(['turn off credential lockdown']);
    expect(refusals).toEqual([]);
  });

  it('falls back to the token alone when the machine cannot ask, and says so', async () => {
    const { check } = gate({ authorized: false, reason: 'unavailable' });
    expect(await check('x', 't', 'c')).toEqual({ ok: true, consent: 'unavailable' });
  });

  it('refuses and records a denial', async () => {
    const { check, refusals } = gate({ authorized: false, reason: 'denied', detail: 'cancelled' });
    const r = await check('x', 'credential_grant', 'Claude Code');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.body.consent).toBe('denied');
      expect(r.body.detail).toBe('cancelled');
    }
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^credential_grant\|Claude Code\|/);
  });

  it('treats a prompt that broke as an error, not an approval', async () => {
    const { check } = gate({ authorized: false, reason: 'error' });
    const r = await check('x', 't', 'c');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body.consent).toBe('error');
  });
});

describe('program path check', () => {
  const real = (map: Record<string, string>) => (p: string): string => {
    if (!(p in map)) throw new Error('ENOENT');
    return map[p];
  };

  it('accepts the file the daemon resolves, through symlinks', () => {
    const err = programPathError(
      '/opt/homebrew/bin/gh',
      'gh',
      () => '/opt/homebrew/bin/gh',
      real({ '/opt/homebrew/bin/gh': '/opt/homebrew/Cellar/gh/2.60.0/bin/gh' }),
    );
    expect(err).toBeUndefined();
  });

  it('accepts a different link to the same file (fly and flyctl)', () => {
    const err = programPathError(
      '/Users/me/.fly/bin/fly',
      'fly',
      () => '/Users/me/.fly/bin/fly',
      real({ '/Users/me/.fly/bin/fly': '/Users/me/.fly/bin/flyctl' }),
    );
    expect(err).toBeUndefined();
  });

  it('refuses a copy of a shell renamed to a bound program', () => {
    const err = programPathError(
      '/tmp/gh',
      'gh',
      () => '/opt/homebrew/bin/gh',
      real({ '/tmp/gh': '/tmp/gh', '/opt/homebrew/bin/gh': '/opt/homebrew/Cellar/gh/2.60.0/bin/gh' }),
    );
    expect(err).toMatch(/not the "gh" Hypergate knows/);
  });

  it('refuses a relative path and a program the daemon cannot see', () => {
    expect(programPathError('gh', 'gh', () => '/usr/bin/gh', (p) => p)).toMatch(/absolute path/);
    expect(programPathError('/usr/local/bin/gh', 'gh', () => undefined, (p) => p)).toMatch(/not on Hypergate's PATH/);
  });

  it('refuses a path that does not exist', () => {
    expect(programPathError('/nope/gh', 'gh', () => '/usr/bin/gh', real({ '/usr/bin/gh': '/usr/bin/gh' }))).toMatch(
      /could not be resolved/,
    );
  });
});

describe('run prompt wording', () => {
  it('names the program and the credentials', () => {
    expect(runReason('gh', ['GitHub token'])).toBe('run "gh" with the credential "GitHub token"');
    expect(runReason('aws', ['a', 'b', 'c', 'd', 'e'])).toBe('run "aws" with the credentials "a", "b", "c" and 2 more');
  });
});
