import { useState } from 'react';
import type { OAuthAppInfo } from '@hypergate/shared';
import { api } from '../../api';
import { Dialog } from '../Dialog';

/**
 * The one-time OAuth app, for a provider that won't register one for you.
 *
 * Most providers implement RFC 7591 dynamic registration, so Hypergate registers
 * itself the first time you sign in and there is nothing to set up. GitHub does
 * not: its authorization server publishes no `registration_endpoint` at all, and
 * it wants client authentication at the token endpoint even with PKCE. Its own
 * MCP binaries ship with credentials baked in; Hypergate has none to bake, so
 * sign-in used to fail with an error naming environment variables — accurate, and
 * useless to anyone who isn't packaging the app.
 *
 * Registering an app takes about two minutes, and the only fiddly part is the
 * callback URL having to match exactly. So that is what this does: hands over the
 * URL for *this* daemon (the port is not always 7777), links straight to the
 * provider's form, and takes the two values back. They go into the OS keychain
 * beside that server's grant, never into servers.json.
 */
export function OAuthAppDialog({
  name,
  info,
  onClose,
  onSaved,
}: {
  name: string;
  info: OAuthAppInfo;
  onClose: () => void;
  /** Called once credentials are stored, so the caller can continue signing in. */
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secretRequired = info.requirement?.secretRequired ?? false;

  const copyRedirect = () => {
    void navigator.clipboard?.writeText(info.redirectUri).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError('Could not copy — select the URL and copy it by hand.'),
    );
  };

  const submit = async () => {
    if (!clientId.trim()) {
      setError('Paste the client ID from the app you registered.');
      return;
    }
    if (secretRequired && !clientSecret.trim()) {
      setError(`${name} needs the client secret as well — generate one on the app's page.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveOAuthApp(info.serverId, clientId.trim(), clientSecret.trim() || undefined);
      onSaved();
    } catch {
      setError('Could not save the app details. Check them and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Set up ${name} sign-in`}
      onClose={onClose}
      description={`${name} doesn't register apps automatically, so browser sign-in needs one OAuth app of your own. This is a one-time setup — every sign-in after it is a single click.`}
    >
      <ol className="oauth-steps">
        <li>
          <a className="btn sm btn-accent" href={info.requirement?.registerUrl} target="_blank" rel="noreferrer">
            Open {name}'s new OAuth app form ↗
          </a>
          {info.requirement?.hint && <div className="small muted" style={{ marginTop: 6 }}>{info.requirement.hint}</div>}
        </li>
        <li>
          Use this exact callback URL:
          <div className="row wrap-gap" style={{ marginTop: 6 }}>
            <code className="mono chip" style={{ userSelect: 'all' }}>{info.redirectUri}</code>
            <button className="btn sm" onClick={copyRedirect}>{copied ? 'Copied!' : 'Copy'}</button>
          </div>
        </li>
        <li>
          Paste the client ID{secretRequired ? ' and a generated client secret' : ''} back here.
          <label className="field" style={{ marginTop: 8 }}>
            Client ID
            <input
              className="mono"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Ov23li…"
            />
          </label>
          <label className="field" style={{ marginTop: 8 }}>
            Client secret{secretRequired ? '' : ' (only if the provider issues one)'}
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={secretRequired ? 'Required by ' + name : 'Optional'}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </label>
        </li>
      </ol>
      <p className="small muted">
        Stored {info.storage === 'keychain' ? 'in your OS keychain' : `in ${info.serverId}'s local credential file`}, never in the server config.
        {info.requirement?.docsUrl && (
          <>
            {' '}
            <a href={info.requirement.docsUrl} target="_blank" rel="noreferrer">Provider docs ↗</a>
          </>
        )}
      </p>
      {info.configured && (
        <p className="small muted">
          An app is already configured ({info.source === 'env' ? 'from the environment' : info.source === 'config' ? 'from the server config' : `client ID ${info.clientIdHint}`}). Saving replaces it.
        </p>
      )}
      {error && <p className="small" style={{ color: 'var(--danger)' }} role="alert">{error}</p>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : 'Save & sign in'}
        </button>
      </div>
    </Dialog>
  );
}
