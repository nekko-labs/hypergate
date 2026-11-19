import { useCallback, useEffect, useState } from 'react';
import type { InstructionsHarnessInfo, InstructionsStatusResponse, InstructionsWriteResponse } from '@hypergate/shared';
import { api } from '../../api';
import { useToast } from '../../toast';

/**
 * "Agent instructions": the Hypergate block in each harness's global
 * instruction file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, ...).
 *
 * Nothing is ever written without a click. The first time someone lands here
 * with a harness detected and no block installed anywhere, a one-time offer
 * sits above the list; dismissing it is remembered in settings, and the list
 * itself stays.
 */

const summarise = (r: InstructionsWriteResponse, verb: string): string => {
  const failed = r.results.filter((x) => x.error);
  if (failed.length) return `${failed.length} file(s) could not be ${verb}: ${failed[0].error}`;
  const changed = r.results.filter((x) => x.changed).length;
  return changed ? `${verb[0].toUpperCase()}${verb.slice(1)} in ${changed} file(s).` : 'Already up to date.';
};

function useInstructions() {
  const [status, setStatus] = useState<InstructionsStatusResponse | null>(null);
  const refresh = useCallback(() => {
    void api.instructions().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(refresh, [refresh]);
  return { status, refresh };
}

export function AgentInstructionsSection({ token }: { token?: string }) {
  const { status, refresh } = useInstructions();
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const toast = useToast();

  useEffect(() => {
    void api.settings().then((s) => setDismissed(!!s.instructionsPromptDismissed)).catch(() => {});
  }, []);

  const write = async (id: string, remove: boolean) => {
    if (!token) return toast.show('No gateway token: reload the page.', 'error');
    setBusy(id);
    try {
      const r = remove ? await api.removeInstructions(id, token) : await api.installInstructions(id, token);
      toast.show(summarise(r, remove ? 'removed' : 'added'), r.ok ? 'success' : 'error');
    } catch {
      toast.show('The daemon could not write the instruction files.', 'error');
    }
    setBusy(null);
    refresh();
  };

  const dismiss = () => {
    setDismissed(true);
    void api.updateSettings({ instructionsPromptDismissed: true }).catch(() => {});
  };

  if (!status) return null;
  const detected = status.harnesses.filter((h) => h.detected);
  const anyInstalled = status.harnesses.some((h) => h.installed);
  const pending = detected.filter((h) => !h.current && !h.damaged);
  const offer = !dismissed && !anyInstalled && detected.length > 0;

  return (
    <>
      <div className="section-title" id="agent-instructions">
        Agent instructions
        <span className="rt">
          <button
            className="btn sm btn-accent"
            disabled={!pending.length || busy !== null}
            onClick={() => void write('all', false)}
            title="Add or update the Hypergate block in every detected harness's global instructions"
          >
            {busy === 'all' ? 'Installing…' : 'Install for all detected'}
          </button>
        </span>
      </div>
      {offer && (
        <div className="panel"><div className="list-row">
          <div style={{ flex: 1 }}>
            <b>Tell your agents how this machine works?</b>
            <div className="small muted">
              Hypergate can add a short block to the global instructions of {detected.map((h) => h.name).join(', ')}:
              keys come from the vault through <code>hypergate run</code>, never written down or pasted, and a missing
              key, CLI or server is requested rather than worked around. It works whichever model the agent runs on.
              Nothing is written until you choose.
            </div>
          </div>
          <div className="row wrap-gap">
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => void write('all', false).then(dismiss)}>
              Add to {detected.length} harness{detected.length === 1 ? '' : 'es'}
            </button>
            <button className="btn" onClick={dismiss}>Not now</button>
          </div>
        </div></div>
      )}
      <div className="panel"><div className="list">
        {status.harnesses.map((h) => (
          <HarnessRow key={h.id} h={h} busy={busy === h.id} onWrite={(remove) => void write(h.id, remove)} />
        ))}
        <div className="list-row small muted">
          Not written to: {status.skipped.map((s) => `${s.name} (${s.reason})`).join(' ')}
        </div>
      </div></div>
    </>
  );
}

function HarnessRow({ h, busy, onWrite }: { h: InstructionsHarnessInfo; busy: boolean; onWrite: (remove: boolean) => void }) {
  const state = h.damaged
    ? <span className="chip chip-danger">needs a hand fix</span>
    : h.current
      ? <span className="chip chip-official">installed</span>
      : h.installed
        ? <span className="chip chip-warning">out of date</span>
        : h.detected
          ? <span className="chip">not installed</span>
          : <span className="chip">not detected</span>;
  return (
    <div className="list-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          <b>{h.name}</b> {state}{' '}
          <a className="small muted" href={h.source} target="_blank" rel="noreferrer">docs ↗</a>
        </div>
        <div className="small muted"><code>{h.path}</code></div>
        {h.note && <div className="small" style={{ color: 'var(--warning)' }}>{h.note}</div>}
      </div>
      <div className="row wrap-gap">
        {h.installed ? (
          <>
            {!h.current && <button className="btn sm" disabled={busy} onClick={() => onWrite(false)}>Update</button>}
            <button className="btn sm" disabled={busy} onClick={() => onWrite(true)}>Remove</button>
          </>
        ) : (
          <button className="btn sm" disabled={busy || !!h.damaged} onClick={() => onWrite(false)}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The offer shown after an agent connects: if its harness has a global
 * instruction file without a current block, one click adds it there.
 */
export function InstructionsOffer({ target }: { target?: string }) {
  const { status, refresh } = useInstructions();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const h = target ? status?.harnesses.find((x) => x.targets.includes(target)) : undefined;
  if (!h || h.current || h.damaged) return null;

  const add = async () => {
    setBusy(true);
    try {
      const { token } = await api.gateway();
      if (!token) throw new Error('no token');
      const r = await api.installInstructions(h.id, token);
      toast.show(summarise(r, 'added'), r.ok ? 'success' : 'error');
    } catch {
      toast.show('The daemon could not write the instruction file.', 'error');
    }
    setBusy(false);
    refresh();
  };

  return (
    <div className="row wrap-gap" style={{ marginTop: 10 }}>
      <button className="btn sm" disabled={busy} onClick={() => void add()}>
        {busy ? 'Adding…' : h.installed ? 'Update Hypergate instructions' : 'Add Hypergate instructions'}
      </button>
      <span className="small muted">
        Puts a short block in <code>{h.path}</code> so every {h.name} session uses the vault and asks before working
        around Hypergate.
      </span>
    </div>
  );
}
