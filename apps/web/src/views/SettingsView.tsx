import { useEffect, useState } from 'react';
import type { SettingsInfo, UpdateSettingsRequest } from '@hypergate/shared';
import { api } from '../api';
import { ToggleRow } from '../components/ToggleRow';

/** Service/desktop options: run at login, start minimized. Talks to /api/settings. */
export function SettingsView() {
  const [s, setS] = useState<SettingsInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api.settings().then(setS).catch(() => setErr('Could not load settings — is the daemon running?'));
  }, []);

  const update = async (patch: UpdateSettingsRequest, key: string) => {
    setBusy(key);
    setErr(null);
    try {
      setS(await api.updateSettings(patch));
    } catch {
      setErr('Could not save the setting, check the daemon logs.');
    }
    setBusy(null);
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="grad-text">Settings</span></h1>
          <p>How Hypergate runs on this machine. Local-first — these only affect your own device.</p>
        </div>
      </div>

      <div className="section-title">Startup &amp; desktop</div>
      <div className="panel">
        {!s ? (
          <div className="list-row small muted">Loading…</div>
        ) : (
          <div className="list">
            <ToggleRow
              label="Run on startup"
              desc={
                s.startupSupported
                  ? 'Launch Hypergate in the tray automatically when you sign in to Windows.'
                  : `Autostart isn't wired up on ${s.platform} yet — it's coming with the desktop shell.`
              }
              checked={s.runOnStartup}
              disabled={!s.startupSupported || busy === 'runOnStartup'}
              onChange={(v) => void update({ runOnStartup: v }, 'runOnStartup')}
            />
            <ToggleRow
              label="Start minimized"
              desc="Stay in the system tray on launch instead of opening the manager window."
              checked={s.startMinimized}
              disabled={busy === 'startMinimized'}
              onChange={(v) => void update({ startMinimized: v }, 'startMinimized')}
            />
          </div>
        )}
      </div>
      {err && <p className="small" style={{ color: 'var(--danger)', marginTop: 10 }}>{err}</p>}
      <p className="small muted" style={{ marginTop: 12 }}>
        Startup launches the tray app, which keeps the daemon running in the background. Right-click the tray icon for
        Open manager / Restart / Quit.
      </p>
    </>
  );
}
