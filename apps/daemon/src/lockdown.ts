import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PresenceConsent } from '@hypergate/shared';
import type { AuthorizeVerdict } from './shell.ts';

/**
 * The daemon's half of credential lockdown: the IO-bound checks the pure policy
 * in `@hypergate/core`'s lockdown.ts cannot do itself.
 *
 * The premise this file is written against: under lockdown the master token is
 * treated as public on this machine. It has to be: the manager UI reads it from
 * `/api/gateway`, the CLI reads it from the keychain without a prompt, and an
 * agent's shell runs as the same user as both. So nothing that hands a value to
 * the bare master token, or widens who can get one, is allowed on the token
 * alone; it needs a person at the keyboard, proved by the OS.
 */

/** A presence-gated door either lets the call through, or answers it. */
export type PresenceResult =
  | { ok: true; consent: PresenceConsent }
  | {
      ok: false;
      status: 403;
      body: { error: string; consent: 'denied' | 'error'; detail?: string };
    };

/**
 * Build the gate. `authorize` is `shell.authorize`; `recordRefusal` writes the
 * refusal into analytics, because "someone tried and was told no" is the half
 * of an audit trail worth having.
 *
 * `unavailable` (no Touch ID, no polkit, a shell binary that predates
 * `authorize`) lets the call through on the master token alone and says so in
 * `consent`, the same fallback the grant door has used since it gained a prompt:
 * failing closed there would make the vault unusable on that machine, and the
 * lockdown status endpoint reports the weaker bar instead of hiding it.
 */
export const presenceGate =
  (deps: {
    authorize: (reason: string) => Promise<AuthorizeVerdict>;
    recordRefusal: (tool: string, client: string, error: string) => void;
  }) =>
  async (reason: string, tool: string, client: string): Promise<PresenceResult> => {
    const verdict = await deps.authorize(reason);
    if (verdict.authorized) return { ok: true, consent: 'approved' };
    if (verdict.reason === 'unavailable') return { ok: true, consent: 'unavailable' };
    const consent = verdict.reason === 'error' ? 'error' : 'denied';
    deps.recordRefusal(tool, client, `refused at the OS prompt under credential lockdown (${consent})`);
    return {
      ok: false,
      status: 403,
      body: {
        error:
          consent === 'denied'
            ? 'Credential lockdown is on and the person at the keyboard did not confirm this.'
            : 'Credential lockdown is on and the confirmation prompt could not be shown.',
        consent,
        detail: verdict.detail,
      },
    };
  };

/**
 * Is `sent` the file this daemon's own PATH resolves `name` to?
 *
 * Binding a credential to `gh` means nothing if any file called `gh` qualifies:
 * `cp /bin/sh /tmp/gh` would then be handed the GitHub token. So under lockdown
 * the program must be an absolute path that resolves (through symlinks, which is
 * how Homebrew and Fly install) to the same file the daemon finds for that name.
 * Returns an error message, or undefined when it matches.
 */
export const programPathError = (
  sent: string,
  name: string,
  resolveOnPath: (command: string) => string | undefined,
  realpath: (p: string) => string = realpathSync,
): string | undefined => {
  if (!isAbsolute(sent))
    return `Credential lockdown needs the program as an absolute path; got "${sent}". Update the hypergate CLI.`;
  const expected = resolveOnPath(name);
  if (!expected)
    return `Refused under credential lockdown: "${name}" is not on Hypergate's PATH, so it cannot be checked. Install it through Hypergate or make sure Hypergate can see it.`;
  let a: string;
  let b: string;
  try {
    a = realpath(sent);
    b = realpath(expected);
  } catch {
    return `Refused under credential lockdown: "${sent}" could not be resolved.`;
  }
  const same = process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same)
    return `Refused under credential lockdown: "${sent}" is not the "${name}" Hypergate knows (${expected}). Credentials are only injected into the real program, not a copy or a lookalike.`;
  return undefined;
};

/** The OS prompt's sentence for a bare-master `hypergate run`, completing "<app> is trying to". */
export const runReason = (program: string, credentials: readonly string[]): string => {
  const names = credentials.slice(0, 3).map((c) => `"${c}"`);
  const more = credentials.length > 3 ? ` and ${credentials.length - 3} more` : '';
  const what = credentials.length === 1 ? `the credential ${names[0]}` : `the credentials ${names.join(', ')}${more}`;
  return `run "${program}" with ${what}`;
};
