import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import type {
  AlertSettingsInfo,
  AmbientImportResult,
  AmbientScanResponse,
  DaemonSettings,
  TestAlertResponse,
  UpdateAlertSettingsRequest,
  WatchEventsResponse,
} from '@hypergate/shared';
import { toFinding, type AmbientCommand, type AmbientHit } from '@hypergate/core';
import { Watcher, fsDeps, userToolDirs, type WatchDeps } from './watch.ts';
import { Alerter, WebhookStore, validateWebhookUrl, webhookHint, type AlertKeychain, type AlertOrigin } from './alerts.ts';
import { importAmbient, purgeBackups, type ImportVault } from './ambient-import.ts';

/**
 * The sweep, the watcher and the alerts, wired together for the daemon.
 *
 * Kept out of index.ts on purpose: index.ts only constructs this, hands it the
 * request, and merges its settings fields. Everything here is reachable through
 * `route()`, which answers `undefined` for paths it does not own.
 */

export interface AmbientServiceDeps {
  dataDir: string;
  /** The home and environment the sweep reads. */
  home: string;
  platform: string;
  env: Record<string, string | undefined>;
  vault: ImportVault;
  catalog: WatchDeps['catalog'];
  resolve(command: string): string | undefined;
  /** `npm prefix -g`, resolved lazily; undefined when npm is absent. */
  npmPrefix(): Promise<string | undefined>;
  /** Run a vendor command without a shell. */
  run(cmd: AmbientCommand): Promise<{ ok: boolean; stdout: string }>;
  notify(title: string, body: string): boolean;
  keychain: AlertKeychain;
  settings(): DaemonSettings;
  post(url: string, body: Record<string, unknown>): Promise<boolean>;
  origin: AlertOrigin;
  /** Restart servers that reference a rolled credential. */
  rolled(credentialId: string): Promise<void>;
  /** Analytics: one row per import, attributed like every other vault door. */
  record(tool: string, ok: boolean, error?: string): void;
  log(line: string): void;
  intervalMs: number;
  windowMs: number;
}

export interface RouteContext {
  master: boolean;
  body(): Promise<string>;
}

export interface RouteReply {
  status: number;
  body: unknown;
}

export const createAmbientService = (d: AmbientServiceDeps) => {
  const fs = fsDeps();
  const webhooks = new WebhookStore(d.dataDir, d.keychain);
  const backupDir = join(d.dataDir, 'ambient-backup');
  const watchDeps: WatchDeps = {
    dataDir: d.dataDir,
    ambient: { home: d.home, platform: d.platform, env: d.env },
    ...fs,
    catalog: d.catalog,
    resolve: d.resolve,
    toolDirs: userToolDirs(d.home, d.platform, d.env, undefined),
    now: () => new Date(),
  };
  const watcher = new Watcher(watchDeps);
  const alerter = new Alerter({
    notify: d.notify,
    post: d.post,
    webhook: () => ({ url: webhooks.get(), format: d.settings().alertWebhookFormat ?? 'json' }),
    origin: d.origin,
    home: d.home,
    windowMs: d.windowMs,
    log: d.log,
  });

  const doImport = async (h: AmbientHit): Promise<AmbientImportResult> => {
    const result = await importAmbient(h, {
      vault: d.vault,
      readFile: fs.readFile,
      writeFile: (p, t) => writeFileSync(p, t),
      deleteFile: (p) => rmSync(p, { force: true }),
      run: d.run,
      backupDir,
      now: () => new Date(),
      rolled: d.rolled,
    });
    d.record('ambient_import', result.ok, result.error);
    if (result.ok) {
      // Only a finding that is gone at the source leaves the baseline: one that
      // stays (an inherited env var) must not come back next pass as "new".
      watcher.forget(
        h.id,
        { kind: 'ambient-imported', tool: h.tool, location: h.location, detail: h.detail, findingId: h.id },
        result.removed,
      );
      watcher.scanNow();
    }
    return result;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  let purgeTimer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const { events, hits } = watcher.pass();
      if (d.settings().autoQuarantine) {
        for (const e of events) {
          if (e.kind === 'cli-new') continue;
          const h = hits.find((x) => x.id === e.findingId);
          // Only what Hypergate can actually take out: quarantining a value it
          // must leave in place would just copy it and call that safe.
          if (!h?.importable || h.removal === 'manual') continue;
          const r = await doImport(h);
          if (r.ok && r.removed) {
            e.quarantined = true;
            watcher.markQuarantined(e.id);
          }
        }
      }
      alerter.add(events);
    } catch (e) {
      d.log(`[watch] pass failed: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      running = false;
    }
  };

  return {
    watcher,
    alerter,

    /** Start polling. The first pass waits a moment so boot stays fast. */
    start(): void {
      void d.npmPrefix().then((prefix) => {
        if (prefix) watchDeps.toolDirs = userToolDirs(d.home, d.platform, d.env, prefix);
      });
      purgeBackups(backupDir, new Date());
      setTimeout(() => void tick(), 3000).unref();
      timer = setInterval(() => void tick(), d.intervalMs);
      timer.unref();
      purgeTimer = setInterval(() => purgeBackups(backupDir, new Date()), 24 * 60 * 60 * 1000);
      purgeTimer.unref();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      if (purgeTimer) clearInterval(purgeTimer);
      void alerter.flush();
    },

    /** Run one watcher pass now (tests and the sweep's "check again"). */
    tick,

    settingsInfo(): AlertSettingsInfo {
      const url = webhooks.get();
      return { alertWebhookConfigured: Boolean(url), alertWebhookHint: url ? webhookHint(url) : undefined };
    },

    /**
     * Apply the alert half of a settings PATCH to `cur`. Every alert field
     * needs the master token: pointing the webhook somewhere else is a way to
     * read this machine's activity, and turning auto-quarantine off is a way to
     * keep a planted key in place.
     */
    applySettings(b: UpdateAlertSettingsRequest, cur: DaemonSettings, master: boolean): void {
      const touches = b.autoQuarantine !== undefined || b.alertWebhookUrl !== undefined || b.alertWebhookFormat !== undefined;
      if (!touches) return;
      if (!master) throw Object.assign(new Error('changing alerts needs the master token'), { status: 401 });
      if (typeof b.autoQuarantine === 'boolean') cur.autoQuarantine = b.autoQuarantine;
      if (b.alertWebhookFormat === 'slack' || b.alertWebhookFormat === 'json') cur.alertWebhookFormat = b.alertWebhookFormat;
      if (b.alertWebhookUrl === null || b.alertWebhookUrl === '') webhooks.set(null);
      else if (typeof b.alertWebhookUrl === 'string') webhooks.set(validateWebhookUrl(b.alertWebhookUrl));
    },

    async route(method: string, pathname: string, ctx: RouteContext): Promise<RouteReply | undefined> {
      if (pathname === '/api/ambient' && method === 'GET') {
        const out: AmbientScanResponse = { findings: watcher.scanNow().map(toFinding), scannedAt: new Date().toISOString() };
        return { status: 200, body: out };
      }
      const m = /^\/api\/ambient\/([^/]+)\/import$/.exec(pathname);
      if (m && method === 'POST') {
        if (!ctx.master) return { status: 401, body: { error: 'unauthorized' } };
        const id = decodeURIComponent(m[1]);
        const h = watcher.scanNow().find((x) => x.id === id);
        if (!h) return { status: 404, body: { error: 'not_found' } };
        const r = await doImport(h);
        return { status: r.ok ? 200 : 409, body: r };
      }
      if (pathname === '/api/watch/events' && method === 'GET') {
        const out: WatchEventsResponse = watcher.events();
        return { status: 200, body: out };
      }
      if (pathname === '/api/alerts/test' && method === 'POST') {
        if (!ctx.master) return { status: 401, body: { error: 'unauthorized' } };
        const r = await alerter.test();
        const out: TestAlertResponse = { ok: r.notified || r.webhook === true, ...r };
        return { status: 200, body: out };
      }
      return undefined;
    },
  };
};

export type AmbientService = ReturnType<typeof createAmbientService>;
