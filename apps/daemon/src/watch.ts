import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliWatchSource, WatchEvent } from '@hypergate/shared';
import { ambientFingerprint, ambientPaths, scanAmbient, type AmbientContext, type AmbientHit } from '@hypergate/core';

/**
 * The watcher: notices new ambient credentials and newly installed CLIs.
 *
 * Polling, not fs.watch. The locations live in a dozen directories across three
 * operating systems, several of which (a missing `~/.fly`) do not exist yet when
 * the watch starts, and fs.watch can neither watch a path that is not there nor
 * be trusted to fire the same way on macOS, Linux and Windows. A 30 second poll
 * that only rescans when an mtime moved costs a few dozen `stat` calls.
 *
 * The baseline lives in `watch.json` so a restart does not re-announce
 * everything. The very first pass on a machine records a baseline and raises
 * nothing: the sweep panel is where existing logins are shown, and an alert
 * storm on install would teach everyone to ignore the alerts.
 *
 * What it does not prove: who wrote a credential. Every process runs as the same
 * user, so "an agent added a GitHub login" and "you ran `gh auth login`" look
 * identical from here, and the alert says so.
 */

/** Everything the watcher touches, injected so tests run on a temp dir. */
export interface WatchDeps {
  dataDir: string;
  ambient: Omit<AmbientContext, 'readFile'>;
  readFile(path: string): string | undefined;
  /** mtime in ms, or undefined when absent. */
  mtime(path: string): number | undefined;
  /** Entries of a directory, or [] when absent. */
  listDir(path: string): string[];
  /** Catalog CLIs: id, display name and command; `resolve` finds one on PATH. */
  catalog: { id: string; name: string; command: string }[];
  resolve(command: string): string | undefined;
  /** Directories where user-installed tools land (see `userToolDirs`). */
  toolDirs: { dir: string; source: CliWatchSource; layout: 'bin' | 'node_modules' }[];
  now(): Date;
}

interface Baseline {
  /** Finding id → value fingerprint ('' when the value lives in a keyring). */
  ambient: Record<string, string>;
  /** `catalog:<id>` or `<source>:<dir>:<name>` keys seen. */
  clis: string[];
  events: WatchEvent[];
  lastPassAt?: string;
}

const MAX_EVENTS = 200;

/**
 * Where tools a person installs for themselves land, one directory per
 * mechanism, chosen because every entry in them is something that was asked
 * for. Deliberately not the whole PATH: `/usr/bin` and Homebrew's `bin` gain
 * executables with every dependency upgrade, and an alert per helper binary
 * would bury the one that matters. Catalog CLIs are still caught wherever they
 * land, through the PATH lookup.
 */
export const userToolDirs = (
  home: string,
  platform: string,
  env: Record<string, string | undefined>,
  npmPrefix: string | undefined,
): WatchDeps['toolDirs'] => {
  const dirs: WatchDeps['toolDirs'] = [];
  if (npmPrefix) {
    dirs.push({
      dir: platform === 'win32' ? join(npmPrefix, 'node_modules') : join(npmPrefix, 'lib', 'node_modules'),
      source: 'npm-global',
      layout: 'node_modules',
    });
  }
  const bins = [
    join(home, '.local', 'bin'), // pipx, uv tool, the Claude Code installer
    env.CARGO_HOME ? join(env.CARGO_HOME, 'bin') : join(home, '.cargo', 'bin'),
    env.GOBIN || join(env.GOPATH || join(home, 'go'), 'bin'),
    env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin') : join(home, '.bun', 'bin'),
    env.DENO_INSTALL_ROOT ? join(env.DENO_INSTALL_ROOT, 'bin') : join(home, '.deno', 'bin'),
  ];
  for (const dir of bins) dirs.push({ dir, source: 'user-bin', layout: 'bin' });
  return dirs;
};

/** Directory entries that are noise in a bin dir: shims' sidecars and dotfiles. */
const isNoise = (name: string): boolean =>
  name.startsWith('.') || /\.(ps1|cmd|bat|exe\.old|pdb|lock|json|md|txt)$/i.test(name);

export class Watcher {
  private deps: WatchDeps;
  private baseline: Baseline | undefined;
  private signature = '';
  private hits: AmbientHit[] = [];
  private scanned = false;
  private pending: WatchEvent[] = [];

  constructor(deps: WatchDeps) {
    this.deps = deps;
  }

  private file(): string {
    return join(this.deps.dataDir, 'watch.json');
  }

  private load(): Baseline | undefined {
    if (this.baseline) return this.baseline;
    const text = this.deps.readFile(this.file());
    if (text === undefined) return undefined;
    try {
      const b = JSON.parse(text) as Partial<Baseline>;
      this.baseline = {
        ambient: b.ambient && typeof b.ambient === 'object' ? b.ambient : {},
        clis: Array.isArray(b.clis) ? b.clis : [],
        events: Array.isArray(b.events) ? b.events.slice(-MAX_EVENTS) : [],
        lastPassAt: b.lastPassAt,
      };
    } catch {
      this.baseline = undefined;
    }
    return this.baseline;
  }

  private save(b: Baseline): void {
    mkdirSync(this.deps.dataDir, { recursive: true });
    writeFileSync(this.file(), JSON.stringify(b, null, 2), { mode: 0o600 });
  }

  /** The latest ambient scan (with values, for the import path only). */
  latest(): AmbientHit[] {
    return this.hits;
  }

  /** Recorded events, newest last. */
  events(): { events: WatchEvent[]; lastPassAt?: string } {
    const b = this.load();
    return { events: b?.events ?? [], lastPassAt: b?.lastPassAt };
  }

  /** Scan now, ignoring the mtime gate. Used by the sweep endpoint. */
  scanNow(): AmbientHit[] {
    this.hits = scanAmbient({ ...this.deps.ambient, readFile: (p) => this.deps.readFile(p) });
    this.scanned = true;
    return this.hits;
  }

  /**
   * Forget a finding the person just moved into the vault, so its removal is
   * not mistaken for anything and its next appearance counts as new.
   */
  forget(findingId: string, event?: Omit<WatchEvent, 'id' | 'at'>, drop = true): void {
    const b = this.load();
    if (!b) {
      // Before the first pass there is no baseline to edit; keep the event so
      // the record of what was moved survives into it.
      if (event) this.pending.push(this.event(event));
      return;
    }
    if (drop) delete b.ambient[findingId];
    if (event) this.push(b, [this.event(event)]);
    this.save(b);
  }

  private seq = 0;
  private event(e: Omit<WatchEvent, 'id' | 'at'>): WatchEvent {
    const at = this.deps.now();
    this.seq += 1;
    return { id: `${at.getTime().toString(36)}-${this.seq}`, at: at.toISOString(), ...e };
  }

  private push(b: Baseline, events: WatchEvent[]): void {
    b.events.push(...events);
    if (b.events.length > MAX_EVENTS) b.events.splice(0, b.events.length - MAX_EVENTS);
  }

  /** Mark one recorded event as quarantined (auto-quarantine moved it). */
  markQuarantined(eventId: string): void {
    const b = this.load();
    const e = b?.events.find((x) => x.id === eventId);
    if (!b || !e) return;
    e.quarantined = true;
    this.save(b);
  }

  private cliKeys(): Map<string, { tool: string; location: string; source: CliWatchSource }> {
    const out = new Map<string, { tool: string; location: string; source: CliWatchSource }>();
    for (const c of this.deps.catalog) {
      const path = this.deps.resolve(c.command);
      if (path) out.set(`catalog:${c.id}`, { tool: c.name, location: path, source: 'catalog' });
    }
    for (const { dir, source, layout } of this.deps.toolDirs) {
      for (const name of this.deps.listDir(dir)) {
        if (isNoise(name)) continue;
        if (layout === 'node_modules' && name.startsWith('@')) {
          for (const sub of this.deps.listDir(join(dir, name))) {
            if (!isNoise(sub)) out.set(`${source}:${dir}:${name}/${sub}`, { tool: `${name}/${sub}`, location: dir, source });
          }
          continue;
        }
        if (layout === 'node_modules' && name === 'npm') continue;
        out.set(`${source}:${dir}:${name}`, { tool: name, location: dir, source });
      }
    }
    return out;
  }

  /**
   * One pass. Returns the new events (already recorded), and the hits they are
   * about so the caller can quarantine without a second scan.
   */
  pass(): { events: WatchEvent[]; hits: AmbientHit[] } {
    const ambientFiles = ambientPaths(this.deps.ambient);
    const signature = ambientFiles.map((p) => `${p}:${this.deps.mtime(p) ?? '-'}`).join('|');
    const rescan = signature !== this.signature || !this.scanned;
    if (rescan) {
      this.scanNow();
      this.signature = signature;
    }
    const clis = this.cliKeys();
    const existing = this.load();
    const now = this.deps.now().toISOString();
    const fingerprints: Record<string, string> = {};
    for (const h of this.hits) fingerprints[h.id] = ambientFingerprint(h.value) ?? '';

    if (!existing) {
      // First pass on this machine: a baseline, not a flood of alerts.
      const b: Baseline = { ambient: fingerprints, clis: [...clis.keys()], events: this.pending.splice(0), lastPassAt: now };
      this.baseline = b;
      this.save(b);
      return { events: [], hits: [] };
    }

    const fresh: WatchEvent[] = [];
    const about: AmbientHit[] = [];
    for (const h of this.hits) {
      const before = existing.ambient[h.id];
      const fp = fingerprints[h.id];
      if (before === undefined) {
        fresh.push(this.event({ kind: 'ambient-new', tool: h.tool, location: h.location, detail: h.detail, findingId: h.id }));
        about.push(h);
      } else if (before !== fp && fp !== '' && before !== '') {
        fresh.push(this.event({ kind: 'ambient-changed', tool: h.tool, location: h.location, detail: h.detail, findingId: h.id }));
        about.push(h);
      }
    }
    const known = new Set(existing.clis);
    for (const [key, c] of clis) {
      if (known.has(key)) continue;
      fresh.push(this.event({ kind: 'cli-new', tool: c.tool, location: c.location, source: c.source }));
    }
    // Disappearances update the baseline silently: removing a login or a tool
    // is not something anyone needs to be alerted about, and it means the same
    // login coming back later counts as new again.
    existing.ambient = fingerprints;
    existing.clis = [...clis.keys()];
    existing.lastPassAt = now;
    this.push(existing, fresh);
    this.save(existing);
    return { events: fresh, hits: about };
  }
}

/** Real-filesystem deps, for the daemon. */
export const fsDeps = (): Pick<WatchDeps, 'readFile' | 'mtime' | 'listDir'> => ({
  readFile(path) {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  },
  mtime(path) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  },
  listDir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
});
