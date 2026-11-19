import { useCallback, useEffect, useState } from 'react';
import type { LockdownStatus } from '@hypergate/shared';
import { api } from '../api';
import { useToast } from '../toast';
import { ToggleRow } from './ToggleRow';

/**
 * The credential lockdown switch, at the top of the Credentials section.
 *
 * On is one click: it only narrows what agents get. Off widens it again, so the
 * daemon asks the OS to confirm a person is at the keyboard first, and the
 * toast says which of three things happened (confirmed, refused, or this
 * machine cannot ask). When there is no prompt at all the row says so up
 * front, because lockdown without one is a much weaker lock than it sounds.
 */
export function LockdownToggle({ token }: { token?: string }) {
  const [status, setStatus] = useState<LockdownStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    void api.lockdown().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!status) return null;

  const flip = async (enabled: boolean) => {
    if (!token) return;
    setBusy(true);
    const res = await api.setLockdown(enabled, token);
    setBusy(false);
    if (!res.ok) {
      toast.show(
        res.consent === 'denied'
          ? 'Lockdown stays on: the confirmation was declined'
          : res.error ?? 'Could not change credential lockdown',
        'error',
      );
      load();
      return;
    }
    setStatus({ enabled: res.enabled, presence: res.presence });
    toast.show(
      enabled
        ? 'Credential lockdown is on: agents no longer receive key values'
        : res.consent === 'unavailable'
          ? 'Credential lockdown is off (this machine cannot ask for confirmation)'
          : 'Credential lockdown is off',
      'success',
    );
  };

  const presence = status.presence;
  const desc = status.enabled
    ? 'Agents never receive a key’s value. Keys reach a command only through hypergate run, and only a program the key is bound to: never a shell, an interpreter, or a command that prints tokens. Turning this off asks you to confirm it is you.'
    : 'Stop handing key values to agents. With lockdown on, agents run commands through hypergate run instead, and grants, key changes and turning lockdown off ask you to confirm it is you.';

  return (
    <div className="list" style={{ marginBottom: 12 }}>
      <ToggleRow
        label="Credential lockdown"
        desc={desc}
        checked={status.enabled}
        disabled={busy || !token}
        onChange={(v) => void flip(v)}
      />
      {!presence.available && (
        <div className="list-row small">
          <span className="chip chip-warning">No confirmation prompt</span>
          <span className="muted">
            This machine cannot ask you to confirm it is you{presence.detail ? ` (${presence.detail})` : ''}. Lockdown
            still keeps values away from agents, but grants, key changes and turning it off fall back to the master
            token, which any local process can read.
          </span>
        </div>
      )}
    </div>
  );
}
