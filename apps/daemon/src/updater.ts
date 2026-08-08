import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { UpdateAsset, UpdateProgress, UpdateResult } from '@hypergate/shared';

/**
 * Downloading an update, as a job the UI can watch.
 *
 * The split with `apps/shell/src/update.rs` is deliberate: **the daemon fetches,
 * the shell installs.** Fetching is a plain HTTP download that changes nothing
 * on disk that anything is running from, so the daemon can do it while staying
 * up and reporting real byte progress. Installing replaces the daemon's own
 * files, so it has to be done by something that outlives the daemon.
 *
 * That split is also what makes "download only" a real option rather than a
 * label: the payload lands in `~/.hypergate/updates/<version>/`, complete and
 * verified, and installing it later is a local file operation with no network
 * and no waiting.
 */

/** How the staging directory marks a download as complete rather than abandoned. */
const MANIFEST = 'manifest.json';

/**
 * How long an install may take before the daemon still being here to time it
 * means the install never began. The shell stops us within a second or two of
 * `apply`, so this is generous by an order of magnitude.
 */
const INSTALL_DEADLINE = 60_000;
const isPlainFilename = (name: string): boolean =>
  !name.includes('/') && !name.includes('\\') && !name.includes('..') && name === name.split(/[\\/]/).pop();

/** What a HEAD says this URL weighs, when it answers at all. */
async function headSize(url: string): Promise<number | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'hypergate' } });
    const len = Number(res.headers.get('content-length'));
    return res.ok && Number.isFinite(len) && len > 0 ? len : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface StagedManifest {
  version: string;
  /** File names, in the order they should be handed to the package manager. */
  files: string[];
  stagedAt: string;
}

export class Updater {
  /** `~/.hypergate/updates` */
  private readonly dir: string;
  private state: UpdateProgress = { stage: 'idle', received: 0 };
  private running: Promise<void> | undefined;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'updates');
  }

  /**
   * What the UI polls. A snapshot, so a caller cannot mutate our state.
   *
   * The installing state has a deadline, because being alive to report it is
   * itself evidence something went wrong: the install replaces this process's
   * own files, so the shell stops it within seconds of starting. Still running
   * a minute later means the updater never got going (no node on PATH, an
   * install the shell refused), and a spinner that never ends is the worst way
   * to say so.
   */
  progress(): UpdateProgress {
    const s = this.state;
    const failed = s.stage === 'installing' && this.lastResult();
    if (failed && !failed.ok) {
      return {
        ...s,
        stage: 'error',
        error: failed.error ?? 'the updater failed before installation started',
      };
    }
    if (s.stage === 'installing' && s.startedAt && Date.now() - new Date(s.startedAt).getTime() > INSTALL_DEADLINE) {
      return {
        ...s,
        stage: 'error',
        error: 'the installer did not start (Hypergate is still running). See ~/.hypergate/update.log for details.',
      };
    }
    return { ...s };
  }

  /** Is a download in flight right now? */
  busy(): boolean {
    return this.state.stage === 'downloading';
  }

  private versionDir(version: string): string {
    return join(this.dir, version);
  }

  /**
   * The newest version sitting fully downloaded on disk, if any.
   *
   * Only a directory with a manifest counts: a half-finished download leaves
   * `.part` files and no manifest, so an interrupted attempt can never be
   * mistaken for something ready to install.
   */
  staged(): StagedManifest | undefined {
    try {
      const entries = readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      const found = entries
        .map((e) => this.manifest(e.name))
        .filter((m): m is StagedManifest => !!m)
        .sort((a, b) => (a.stagedAt < b.stagedAt ? 1 : -1));
      return found[0];
    } catch {
      return undefined;
    }
  }

  /** Absolute paths of a staged version's files, in install order. */
  stagedFiles(version: string): string[] {
    const m = this.manifest(version);
    if (!m) return [];
    return m.files.map((f) => join(this.versionDir(version), f));
  }

  private manifest(version: string): StagedManifest | undefined {
    try {
      const path = join(this.versionDir(version), MANIFEST);
      if (!existsSync(path)) return undefined;
      const m = JSON.parse(readFileSync(path, 'utf8')) as StagedManifest;
      // A manifest whose files went missing is not a staged update.
      if (!m.files?.every((f) => isPlainFilename(f) && existsSync(join(this.versionDir(version), f)))) return undefined;
      return m;
    } catch {
      return undefined;
    }
  }

  /** Forget a staged version (after it is installed, or when it is superseded). */
  discard(version?: string): void {
    try {
      if (version) rmSync(this.versionDir(version), { recursive: true, force: true });
      else rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best-effort: a leftover tarball is harmless */
    }
  }

  /** The last completed update's outcome, written by the updater script. */
  lastResult(): UpdateResult | undefined {
    try {
      const path = join(this.dir, 'last-result.json');
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, 'utf8')) as UpdateResult;
    } catch {
      return undefined;
    }
  }

  /** Read the outcome once and clear it, so it is reported exactly one time. */
  takeLastResult(): UpdateResult | undefined {
    const r = this.lastResult();
    if (r) {
      try {
        rmSync(join(this.dir, 'last-result.json'), { force: true });
      } catch {
        /* it will simply be reported again */
      }
    }
    return r;
  }

  /**
   * Start (or join) a download of `version`.
   *
   * Idempotent on purpose: pressing Download and then Download & install must
   * not fetch the payload twice, so a second call for the same version joins
   * the run already in flight, and an already-staged version resolves at once.
   */
  download(version: string, assets: UpdateAsset[]): Promise<void> {
    if (this.manifest(version)) {
      this.state = { stage: 'staged', version, received: 0, total: 0, fraction: 1 };
      return Promise.resolve();
    }
    if (this.running && this.state.version === version && this.state.stage === 'downloading') return this.running;
    this.running = this.run(version, assets).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Mark the state as installing; the shell takes it from here (and we die). */
  installing(version: string): void {
    try {
      rmSync(join(this.dir, 'last-result.json'), { force: true });
    } catch {
      /* a stale result must not affect this attempt */
    }
    this.state = { stage: 'installing', version, received: 0, startedAt: new Date().toISOString() };
  }

  /** Record a failure the download itself didn't raise (e.g. the shell refused). */
  failed(version: string, error: string): void {
    this.state = { stage: 'error', version, received: this.state.received, total: this.state.total, error };
  }

  private async run(version: string, assets: UpdateAsset[]): Promise<void> {
    this.state = { stage: 'downloading', version, received: 0, startedAt: new Date().toISOString() };
    // A GitHub release states each asset's size; an npm packument does not, and
    // a progress bar that can't fill is barely a progress bar. Two HEAD requests
    // are cheap next to the megabytes about to follow, and a feed that won't
    // answer them just means the bar stays indeterminate.
    const sized = await Promise.all(assets.map(async (a) => (typeof a.size === 'number' ? a : { ...a, size: await headSize(a.url) })));
    const total = sized.every((a) => typeof a.size === 'number') ? sized.reduce((n, a) => n + (a.size ?? 0), 0) : undefined;
    this.state = { ...this.state, total };
    assets = sized;

    const dir = this.versionDir(version);
    try {
      // Anything left from an interrupted attempt is not worth resuming: these
      // are a couple of megabytes, and a half-written tarball that looks whole
      // is the one outcome worth ruling out entirely.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });

      let done = 0;
      for (const a of assets) {
        this.state = { ...this.state, file: a.name };
        await this.fetchAsset(a, dir, done);
        done += a.size ?? 0;
        // Without declared sizes the received count is still real; only the
        // fraction is unknown, and the UI shows an indeterminate bar for that.
        if (typeof a.size !== 'number') done = this.state.received;
      }

      const manifest: StagedManifest = { version, files: assets.map((a) => a.name), stagedAt: new Date().toISOString() };
      writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
      this.state = { stage: 'staged', version, received: this.state.received, total: this.state.total, fraction: 1 };

      // One staged version at a time: an older download is dead weight the
      // moment a newer one lands.
      for (const other of readdirSync(this.dir, { withFileTypes: true })) {
        if (other.isDirectory() && other.name !== version) this.discard(other.name);
      }
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      this.state = {
        stage: 'error',
        version,
        received: this.state.received,
        total: this.state.total,
        error: e instanceof Error ? e.message : 'the download failed',
      };
      throw e;
    }
  }

  /** Stream one asset to disk, verifying it if the feed told us what to expect. */
  private async fetchAsset(a: UpdateAsset, dir: string, alreadyDone: number): Promise<void> {
    if (!isPlainFilename(a.name)) {
      throw new Error(`${a.name}: update asset name is not a plain filename`);
    }
    const ctrl = new AbortController();
    // Generous but finite: a stalled connection must not leave the UI showing
    // a spinner for the rest of the session.
    const timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
    const part = join(dir, `${a.name}.part`);
    try {
      const res = await fetch(a.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'hypergate', Accept: 'application/octet-stream' },
      });
      if (!res.ok || !res.body) throw new Error(`${a.name}: the download returned ${res.status}`);

      const sha512 = createHash('sha512');
      const sha1 = createHash('sha1');
      const sha256 = createHash('sha256');
      let received = 0;
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on('data', (chunk: Buffer) => {
        sha512.update(chunk);
        sha1.update(chunk);
        sha256.update(chunk);
        received += chunk.length;
        this.state = {
          ...this.state,
          received: alreadyDone + received,
          fraction: this.state.total ? Math.min(1, (alreadyDone + received) / this.state.total) : undefined,
        };
      });
      await pipeline(body, createWriteStream(part));

      // An update is the one download where a corrupted byte gets installed and
      // then run, so whatever the feed committed to is checked before the file
      // is allowed to lose its `.part` suffix.
      if (a.source === 'github' && !a.sha256) {
        throw new Error(`${a.name}: GitHub release has no usable SHA256SUMS entry`);
      }
      if (a.sha256 && sha256.digest('hex') !== a.sha256.toLowerCase()) {
        throw new Error(`${a.name}: SHA-256 integrity check failed`);
      }
      if (a.integrity?.startsWith('sha512-')) {
        const got = `sha512-${sha512.digest('base64')}`;
        if (got !== a.integrity) throw new Error(`${a.name}: integrity check failed`);
      } else if (a.shasum) {
        if (sha1.digest('hex') !== a.shasum) throw new Error(`${a.name}: checksum did not match`);
      }
      if (typeof a.size === 'number' && received !== a.size) {
        throw new Error(`${a.name}: expected ${a.size} bytes, got ${received}`);
      }
      renameSync(part, join(dir, a.name));
    } finally {
      clearTimeout(timer);
      rmSync(part, { force: true });
    }
  }
}
