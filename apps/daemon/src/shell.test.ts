import { describe, it, expect } from 'vitest';
import { verdictFromExit } from './shell.ts';

/**
 * The reveal door's exit-code contract, shared with `apps/shell/src/authorize.rs`.
 *
 * Worth its own test because every wrong answer here is both invisible and
 * user-facing: the daemon cannot tell from the outside whether a prompt was
 * shown, so the code is the entire signal, and the wrong mapping produces a
 * confident, wrong sentence in the UI.
 */
describe('verdictFromExit', () => {
  it('only ever authorizes on a clean exit', () => {
    expect(verdictFromExit(0, '')).toEqual({ authorized: true });
  });

  it('reports a refusal as a refusal', () => {
    // Exit 1 is our own "a prompt appeared and the answer was no".
    expect(verdictFromExit(1, '')).toEqual({ authorized: false, reason: 'denied', detail: undefined });
  });

  it('reports "no prompt on this machine" as unavailable, with the reason', () => {
    // Exit 3 carries an explanation on stderr, which the UI shows verbatim:
    // "there is no polkit here" is actionable, "denied" is not.
    expect(verdictFromExit(3, 'no pkexec on this system\n')).toEqual({
      authorized: false,
      reason: 'unavailable',
      detail: 'no pkexec on this system',
    });
  });

  it('treats an old binary that has never heard of "authorize" as unavailable, not denied', () => {
    // The regression this exists for. clap exits 2 for an unknown subcommand,
    // which is exactly what a v1.8.0-or-earlier `hypergate` does here. Calling
    // that "denied" told users they had been refused when the real problem was
    // that the shell binary was behind the daemon. The two are installed
    // separately, so this is the normal state right after an update.
    const v = verdictFromExit(2, '');
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe('unavailable');
    expect(v.detail).toMatch(/does not support "authorize"/);
    expect(v.detail).toMatch(/update/i);
  });

  it('keeps clap\'s own message when it gave us one', () => {
    expect(verdictFromExit(2, "error: unrecognized subcommand 'authorize'").detail).toBe(
      "error: unrecognized subcommand 'authorize'",
    );
  });

  it('calls a killed process an error, not a refusal', () => {
    // null means our timeout fired or it died on a signal. Nobody said no.
    expect(verdictFromExit(null, '')).toEqual({ authorized: false, reason: 'error', detail: undefined });
  });

  it('never guesses "denied" for a code it does not recognise', () => {
    // Not knowing is not the same as being told no, and only `denied` should
    // read to the user as a refusal.
    for (const code of [4, 7, 42, 126, 127, 255]) {
      const v = verdictFromExit(code, '');
      expect(v.authorized, `exit ${code}`).toBe(false);
      expect(v.reason, `exit ${code}`).toBe('unavailable');
      expect(v.detail, `exit ${code}`).toContain(String(code));
    }
  });

  it('fails closed for every non-zero code', () => {
    for (const code of [1, 2, 3, 4, 126, 127, 255, null]) {
      expect(verdictFromExit(code, 'anything').authorized, `exit ${code}`).toBe(false);
    }
  });

  it('trims stderr and drops it when empty', () => {
    expect(verdictFromExit(1, '   \n  ').detail).toBeUndefined();
    expect(verdictFromExit(1, '  boom \n').detail).toBe('boom');
  });
});
