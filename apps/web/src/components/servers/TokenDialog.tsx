import { useState } from 'react';
import { Dialog } from '../Dialog';

export function TokenDialog({
  name,
  label = 'Bearer token',
  url,
  onClose,
  onSubmit,
}: {
  name: string;
  label?: string;
  url?: string;
  onClose: () => void;
  onSubmit: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!token.trim()) {
      setError(`Paste a ${label.toLowerCase()} to continue.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(token.trim());
    } catch {
      setError('Could not save the token. Check it and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Add ${name} with a token`}
      onClose={onClose}
      description={`Paste a ${label} below. Hypergate stores it locally and sends it only as an Authorization bearer credential.`}
    >
      <label className="field">
        {label}
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste token"
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
      </label>
      {url && (
        <p className="small muted">
          Create one at <a href={url} target="_blank" rel="noreferrer">the provider's token settings</a>.
        </p>
      )}
      {error && <p className="small" style={{ color: 'var(--danger)' }} role="alert">{error}</p>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Connecting…' : 'Save & connect'}
        </button>
      </div>
    </Dialog>
  );
}
