import { useState } from 'react';
import type { AlertWebhookFormat, SettingsInfo, UpdateSettingsRequest } from '@hypergate/shared';
import { ambientApi } from '../ambientApi';
import { useToast } from '../toast';
import { ToggleRow } from './ToggleRow';

/**
 * Alerts and auto-quarantine, in Settings. Every field here needs the master
 * token, and the webhook URL is write-only: the daemon keeps it in the keychain
 * and only ever shows a masked hint back.
 */
export function AlertSettings({ s, token, onChange }: { s: SettingsInfo; token?: string; onChange: (s: SettingsInfo) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const save = async (patch: UpdateSettingsRequest, key: string, done?: string) => {
    if (!token) return;
    setBusy(key);
    try {
      onChange(await ambientApi.updateAlertSettings(patch, token));
      if (done) toast.show(done, 'success');
      if (patch.alertWebhookUrl !== undefined) setUrl('');
    } catch (e) {
      toast.show(`Could not save: ${e instanceof Error ? e.message : 'error'}`, 'error');
    }
    setBusy(null);
  };

  const test = async () => {
    if (!token) return;
    setBusy('test');
    try {
      const r = await ambientApi.testAlert(token);
      const parts = [
        r.notified ? 'notification shown' : 'no notification (this desktop cannot show one)',
        r.webhook === undefined ? '' : r.webhook ? 'team webhook accepted it' : 'team webhook did not accept it',
      ].filter(Boolean);
      toast.show(`Test alert: ${parts.join(', ')}`, r.webhook === false ? 'error' : 'info');
    } catch (e) {
      toast.show(`Test alert failed: ${e instanceof Error ? e.message : 'error'}`, 'error');
    }
    setBusy(null);
  };

  const format: AlertWebhookFormat = s.alertWebhookFormat ?? 'json';
  return (
    <div className="list">
      <ToggleRow
        label="Quarantine new logins automatically"
        desc={
          'When a tool or an agent writes a new key outside the vault (an rc file, a CLI login), move it into the vault ' +
          'and take it out at the source straight away, backing the file up first. Off: you get an alert and decide.'
        }
        checked={s.autoQuarantine === true}
        disabled={!token || busy === 'autoQuarantine'}
        onChange={(v) => void save({ autoQuarantine: v }, 'autoQuarantine')}
      />
      <div className="list-row setting-row">
        <div className="setting-text" style={{ flex: 1 }}>
          <div className="setting-label">Team alert webhook</div>
          <div className="small muted">
            Also send each alert to your team (a Slack incoming webhook, or any URL that takes JSON). It carries the
            machine, user, tool and location, never a key or part of one. This is the only call Hypergate makes on its
            own, and only once you set it.
            {s.alertWebhookConfigured && (
              <> Currently sending to <span className="mono">{s.alertWebhookHint}</span>.</>
            )}
          </div>
          <div className="row wrap-gap" style={{ gap: 8, marginTop: 8 }}>
            <input
              className="mono"
              style={{ flex: 1, minWidth: 240 }}
              type="url"
              placeholder={s.alertWebhookConfigured ? 'Replace with a new URL' : 'https://hooks.slack.com/services/…'}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              className="btn sm btn-primary"
              disabled={!token || !url.trim() || busy === 'url'}
              onClick={() => void save({ alertWebhookUrl: url.trim() }, 'url', 'Team webhook saved')}
            >
              Save
            </button>
            {s.alertWebhookConfigured && (
              <button className="btn sm" disabled={!token || busy === 'url'} onClick={() => void save({ alertWebhookUrl: null }, 'url', 'Team webhook removed')}>
                Remove
              </button>
            )}
          </div>
        </div>
        <div className="seg" style={{ flex: 'none' }}>
          {(['json', 'slack'] as const).map((f) => (
            <button key={f} className={format === f ? 'active' : ''} disabled={!token || busy === 'format'} onClick={() => void save({ alertWebhookFormat: f }, 'format')}>
              {f === 'json' ? 'JSON' : 'Slack'}
            </button>
          ))}
        </div>
      </div>
      <div className="list-row setting-row">
        <div className="setting-text">
          <div className="setting-label">Send a test alert</div>
          <div className="small muted">Shows a notification here and, if a webhook is set, posts a sample event to it.</div>
        </div>
        <button className="btn sm" disabled={!token || busy === 'test'} onClick={() => void test()}>
          {busy === 'test' ? 'Sending…' : 'Send test alert'}
        </button>
      </div>
    </div>
  );
}
