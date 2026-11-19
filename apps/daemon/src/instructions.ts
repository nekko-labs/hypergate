import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  InstructionsHarnessInfo,
  InstructionsStatusResponse,
  InstructionsWriteResult,
} from '@hypergate/shared';
import {
  INSTRUCTION_HARNESSES,
  INSTRUCTIONS_BLOCK_VERSION,
  INSTRUCTIONS_SKIPPED,
  instructionsBlockStatus,
  removeInstructionsBlock,
  renderInstructionsBlock,
  resolveHarness,
  safeAgentKey,
  upsertInstructionsBlock,
  type InstructionsContext,
  type InstructionsHarness,
} from '@hypergate/core';

/**
 * The filesystem half of agent instruction files (the pure half is core's
 * `agent-instructions.ts`).
 *
 * Writes only ever happen because someone pressed Install or ran
 * `hypergate instructions install`: nothing here runs on boot. Before Hypergate
 * first changes a file that already existed, the original is copied to
 * `~/.hypergate/instructions-backup/`, once per harness, so the user can always
 * get back the file exactly as it was before Hypergate ever touched it.
 */

/** Env vars a caller may forward as config homes. Anything else is ignored. */
const HOME_ENV_KEYS = new Set(INSTRUCTION_HARNESSES.flatMap((h) => (h.homeEnv ? [h.homeEnv] : [])));

const readText = (p: string): string | undefined => {
  try {
    return statSync(p).isFile() ? readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
};

export class AgentInstructions {
  // Plain fields, not parameter properties: the daemon also runs under Node's
  // strip-only TypeScript mode, which refuses those.
  private readonly home: string;
  private readonly backupDir: string;
  /** The daemon's own environment, for `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. */
  private readonly env: Record<string, string | undefined>;

  constructor(home: string, backupDir: string, env: Record<string, string | undefined> = process.env) {
    this.home = home;
    this.backupDir = backupDir;
    this.env = env;
  }

  private ctx(homes?: Record<string, string>): InstructionsContext {
    const env: Record<string, string | undefined> = {};
    for (const k of HOME_ENV_KEYS) env[k] = this.env[k];
    // The caller's shell knows better than a daemon launchd started; only the
    // known keys, and `resolveHarness` still checks each is a real directory
    // under home before using it.
    for (const [k, v] of Object.entries(homes ?? {})) if (HOME_ENV_KEYS.has(k) && typeof v === 'string') env[k] = v;
    return { home: this.home, env, exists: existsSync, read: readText };
  }

  status(agentKeyFor: (h: InstructionsHarness) => string, homes?: Record<string, string>): InstructionsStatusResponse {
    const ctx = this.ctx(homes);
    const harnesses: InstructionsHarnessInfo[] = INSTRUCTION_HARNESSES.map((h) => {
      const r = resolveHarness(h, ctx);
      const agentKey = safeAgentKey(agentKeyFor(h), h.id);
      const st = instructionsBlockStatus(readText(r.path), renderInstructionsBlock(agentKey));
      return {
        id: h.id,
        name: h.name,
        targets: h.targets,
        path: r.path,
        detected: r.detected,
        installed: st.installed,
        ...(st.version !== undefined ? { version: st.version } : {}),
        current: st.current,
        agentKey,
        source: h.source,
        ...(r.note ? { note: r.note } : {}),
        ...(st.damaged ? { damaged: true } : {}),
      };
    });
    return { blockVersion: INSTRUCTIONS_BLOCK_VERSION, harnesses, skipped: INSTRUCTIONS_SKIPPED };
  }

  /**
   * Which harnesses `id` names. `all` means every detected harness on install
   * and every harness that has a block on remove. Two harnesses can resolve to
   * the same file (OpenCode falling back to Claude Code's), so the list is
   * de-duplicated by path: one file, one write.
   */
  private pick(
    id: string,
    mode: 'install' | 'remove',
    ctx: InstructionsContext,
  ): { h: InstructionsHarness; path: string }[] {
    const rows =
      id === 'all'
        ? INSTRUCTION_HARNESSES.filter((h) => {
            const r = resolveHarness(h, ctx);
            return mode === 'install' ? r.detected : instructionsBlockStatus(readText(r.path), '').installed;
          })
        : INSTRUCTION_HARNESSES.filter((h) => h.id === id);
    if (!rows.length && id !== 'all') throw new Error(`unknown harness "${id}"`);
    // Every path is planned here, before anything is written. Resolving again
    // per write would let a file created earlier in the batch change where a
    // later harness lands (OpenCode falls back to Claude Code's file once it
    // exists), and its block would then overwrite Claude Code's.
    const seen = new Set<string>();
    const out: { h: InstructionsHarness; path: string }[] = [];
    for (const h of rows) {
      const path = resolveHarness(h, ctx).path;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ h, path });
    }
    return out;
  }

  install(
    id: string,
    agentKeyFor: (h: InstructionsHarness) => string,
    homes?: Record<string, string>,
  ): InstructionsWriteResult[] {
    const ctx = this.ctx(homes);
    return this.pick(id, 'install', ctx).map(({ h, path }) => {
      try {
        const before = readText(path);
        const after = upsertInstructionsBlock(before, renderInstructionsBlock(safeAgentKey(agentKeyFor(h), h.id)));
        if (after === before) return { id: h.id, path, changed: false };
        const backup = before === undefined ? undefined : this.backupOnce(h.id, path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, after);
        return { id: h.id, path, changed: true, ...(backup ? { backup } : {}) };
      } catch (e) {
        return { id: h.id, path, changed: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  remove(id: string, homes?: Record<string, string>): InstructionsWriteResult[] {
    const ctx = this.ctx(homes);
    return this.pick(id, 'remove', ctx).map(({ h, path }) => {
      try {
        const before = readText(path);
        if (before === undefined) return { id: h.id, path, changed: false };
        const after = removeInstructionsBlock(before);
        if (after === before) return { id: h.id, path, changed: false };
        // A file that held nothing but the block was ours to begin with.
        if (after.trim() === '') rmSync(path, { force: true });
        else writeFileSync(path, after);
        return { id: h.id, path, changed: true };
      } catch (e) {
        return { id: h.id, path, changed: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /** Copy the original aside the first time Hypergate changes it; later writes keep that first copy. */
  private backupOnce(harnessId: string, path: string): string | undefined {
    mkdirSync(this.backupDir, { recursive: true });
    const prefix = `${harnessId}-`;
    if (readdirSync(this.backupDir).some((f) => f.startsWith(prefix))) return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(this.backupDir, `${prefix}${stamp}-${basename(path)}`);
    copyFileSync(path, dest);
    return dest;
  }
}
