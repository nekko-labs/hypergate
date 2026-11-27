import { useCallback, useEffect, useState } from 'react';
import type { InstructionsHarnessInfo, InstructionsStatusResponse, InstructionsWriteResponse } from '@hypergate/shared';
import { api } from '../../api';
import { useToast } from '../../toast';

/**
 * Agent instructions: the Hypergate block in each harness's global instruction
 * file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, ...).
 *
 * There is no list of its own any more. A harness's file is part of that agent's
 * setup, so it is shown inside the agent's row under Connected agents, and a
 * harness that is on this machine but not connected shows it in the "Detected,
 * not connected" list beneath. Nothing is ever written without a click.
 */

const summarise = (r: InstructionsWriteResponse, verb: string): string => {
  const failed = r.results.filter((x) => x.error);
  if (failed.length) return `${failed.length} file(s) could not be ${verb}: ${failed[0].error}`;
  const changed = r.results.filter((x) => x.changed).length;
  return changed ? `${verb[0].toUpperCase()}${verb.slice(1)} in ${changed} file(s).` : 'Already up to date.';
};

export interface Instructions {
  status: InstructionsStatusResponse | null;
  /** The harness id being written, or `all`. */
  busy: string | null;
  write: (id: string, remove: boolean) => Promise<void>;
}

/** Instruction-file status for the whole page, with the one write path. */
export function useInstructions(): Instructions {
  const [status, setStatus] = useState<InstructionsStatusResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const refresh = useCallback(() => {
    void api.instructions().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(refresh, [refresh]);

  const write = useCallback(async (id: string, remove: boolean) => {
    setBusy(id);
    try {
      const { token } = await api.gateway();
      if (!token) throw new Error('no token');
      const r = remove ? await api.removeInstructions(id, token) : await api.installInstructions(id, token);
      toast.show(summarise(r, remove ? 'removed' : 'added'), r.ok ? 'success' : 'error');
    } catch {
      toast.show('The daemon could not write the instruction files.', 'error');
    }
    setBusy(null);
    refresh();
  }, [refresh, toast]);

  return { status, busy, write };
}

/**
 * The harness whose instruction file serves this agent: by catalog target for an
 * agent picked from the catalog, by name for one added by hand (a custom agent
 * called "Codex" is Codex).
 */
export function harnessFor(
  status: InstructionsStatusResponse | null,
  agent: { target?: string; name: string },
): InstructionsHarnessInfo | undefined {
  if (!status) return undefined;
  return agent.target
    ? status.harnesses.find((h) => h.targets.includes(agent.target!))
    : status.harnesses.find((h) => h.name.toLowerCase() === agent.name.trim().toLowerCase());
}

/** A small state chip for a harness's file. */
export function InstructionsChip({ h }: { h: InstructionsHarnessInfo }) {
  if (h.damaged) return <span className="chip chip-danger" title={h.path}>instructions need a hand fix</span>;
  if (h.current) return <span className="chip chip-official" title={h.path}>instructions installed</span>;
  if (h.installed) return <span className="chip chip-warning" title={h.path}>instructions out of date</span>;
  return <span className="chip chip-warning" title={h.path}>no instructions</span>;
}

/**
 * The instructions part of an agent's details.
 *
 * Once the block is installed and current there is nothing to set up, so the
 * explanation and the button go away and only a one-line status stays, with
 * Remove for anyone who wants it gone.
 */
export function AgentInstructionsBlock({ h, ins }: { h: InstructionsHarnessInfo; ins: Instructions }) {
  const busy = ins.busy === h.id || ins.busy === 'all';
  if (h.current) {
    return (
      <div className="row wrap-gap instr-done">
        <span className="small muted">
          ✓ Hypergate block in <code style={{ overflowWrap: 'anywhere' }}>{h.path}</code>
        </span>
        <button className="btn sm btn-ghost" disabled={busy} onClick={() => void ins.write(h.id, true)}>
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    );
  }
  return (
    <div className="instr-setup">
      <div className="small muted">
        Adds a short block to <code style={{ overflowWrap: 'anywhere' }}>{h.path}</code> so every {h.name} session takes
        keys from the vault through <code>hypergate run</code>, never writes them down, and asks for a missing key, CLI or
        server instead of working around Hypergate.{' '}
        <a href={h.source} target="_blank" rel="noreferrer">docs ↗</a>
      </div>
      {h.note && <div className="small" style={{ color: 'var(--warning)', marginTop: 6 }}>{h.note}</div>}
      <div className="row wrap-gap" style={{ marginTop: 10 }}>
        {h.damaged ? (
          <span className="small muted">The file has a Hypergate start marker with no end marker. Fix it by hand first.</span>
        ) : (
          <button className="btn sm btn-primary" disabled={busy} onClick={() => void ins.write(h.id, false)}>
            {busy ? 'Writing…' : h.installed ? 'Update instructions' : 'Add instructions'}
          </button>
        )}
        {h.installed && !h.damaged && (
          <button className="btn sm btn-ghost" disabled={busy} onClick={() => void ins.write(h.id, true)}>Remove</button>
        )}
      </div>
    </div>
  );
}

/**
 * A one-time offer above the agents list: shown when a harness is detected and
 * no block is installed anywhere. Dismissing it is remembered in settings.
 */
export function InstructionsFirstOffer({ ins }: { ins: Instructions }) {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    void api.settings().then((s) => setDismissed(!!s.instructionsPromptDismissed)).catch(() => {});
  }, []);
  const dismiss = () => {
    setDismissed(true);
    void api.updateSettings({ instructionsPromptDismissed: true }).catch(() => {});
  };
  const status = ins.status;
  if (!status || dismissed) return null;
  const detected = status.harnesses.filter((h) => h.detected);
  if (status.harnesses.some((h) => h.installed) || detected.length === 0) return null;
  return (
    <div className="panel" style={{ marginBottom: 10 }}><div className="list-row">
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
        <button className="btn btn-primary" disabled={ins.busy !== null} onClick={() => void ins.write('all', false).then(dismiss)}>
          Add to {detected.length} harness{detected.length === 1 ? '' : 'es'}
        </button>
        <button className="btn" onClick={dismiss}>Not now</button>
      </div>
    </div></div>
  );
}
