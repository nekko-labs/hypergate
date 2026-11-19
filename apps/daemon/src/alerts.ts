import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertWebhookFormat, WatchEvent } from '@hypergate/shared';

/**
 * Alerts: telling the person at this machine, and optionally their team, that
 * the watcher saw something.
 *
 * Two channels with different trust. The OS notification stays on the machine.
 * The webhook is the **only** outbound call the daemon makes on its own, so it
 * is off until someone configures a URL, and its payload is built here, in one
 * place, from fields that cannot carry a secret: host, user, event kind, tool
 * name, location, time. No value and no masked hint, ever, because a channel a
 * whole team reads is the last place a key should leak into.
 */

const KIND_LABEL: Record<WatchEvent['kind'], string> = {
  'ambient-new': 'New login outside the vault',
  'ambient-changed': 'Login changed outside the vault',
  'ambient-imported': 'Login moved into the vault',
  'cli-new': 'New command-line tool',
};

const shortLocation = (location: string, home: string): string =>
  home && location.startsWith(home) ? `~${location.slice(home.length)}` : location;

/** One line per event, for a person. */
export const describeEvent = (e: WatchEvent, home = ''): string => {
  const where = shortLocation(e.location, home);
  const what = e.detail ? `${e.tool} (${e.detail})` : e.tool;
  const tail = e.quarantined ? ', moved into the vault automatically' : '';
  return `${KIND_LABEL[e.kind]}: ${what} in ${where}${tail}`;
};

/** Title and body for one coalesced OS notification. */
export const notificationFor = (events: WatchEvent[], home = ''): { title: string; body: string } | undefined => {
  const shown = events.filter((e) => e.kind !== 'ambient-imported');
  if (!shown.length) return undefined;
  if (shown.length === 1) {
    const e = shown[0];
    return { title: `Hypergate: ${KIND_LABEL[e.kind]}`, body: describeEvent(e, home).replace(/^[^:]+: /, '') };
  }
  const logins = shown.filter((e) => e.kind !== 'cli-new').length;
  const clis = shown.length - logins;
  const parts = [
    logins ? `${logins} login${logins === 1 ? '' : 's'} outside the vault` : '',
    clis ? `${clis} new command-line tool${clis === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return { title: 'Hypergate noticed changes', body: `${parts.join(' and ')}. Open Hypergate to review.` };
};

export interface AlertOrigin {
  host: string;
  user: string;
  platform: string;
  version: string;
}

/** The webhook body. Built only from value-free fields; see the module comment. */
export const webhookBody = (
  format: AlertWebhookFormat,
  events: WatchEvent[],
  origin: AlertOrigin,
  test = false,
): Record<string, unknown> => {
  const clean = events.map((e) => ({
    kind: e.kind,
    tool: e.tool,
    location: e.location,
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.source ? { source: e.source } : {}),
    ...(e.quarantined ? { quarantined: true } : {}),
    at: e.at,
  }));
  if (format === 'slack') {
    const head = test
      ? `Hypergate test alert from ${origin.user}@${origin.host}`
      : `Hypergate on ${origin.user}@${origin.host} noticed ${events.length} change${events.length === 1 ? '' : 's'}`;
    // Slack incoming webhooks render `text`; nothing else is needed, and
    // sending only that keeps other Slack-compatible receivers (Mattermost,
    // Discord's /slack endpoint) happy too.
    const lines = events.map((e) => `• ${describeEvent(e)}`);
    return { text: [head, ...lines].join('\n') };
  }
  return {
    source: 'hypergate',
    test,
    host: origin.host,
    user: origin.user,
    platform: origin.platform,
    version: origin.version,
    events: clean,
  };
};

/** An http(s) URL, or an error saying why not. */
export const validateWebhookUrl = (raw: string): string => {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('the webhook must be a full http(s) URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the webhook must be an http(s) URL');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    throw new Error('use https for a webhook that leaves this machine');
  return u.toString();
};

/** A webhook URL as the UI may show it: host plus the last four characters. */
export const webhookHint = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}/…${url.slice(-4)}`;
  } catch {
    return '…';
  }
};

/** Keychain access, the vault's shape. */
export interface AlertKeychain {
  available(): boolean;
  get(key: string): string | undefined;
  set(key: string, value: string): boolean;
  delete(key: string): boolean;
}

const KEY = 'alert:webhook';

/**
 * Where the webhook URL lives: the OS keychain, else a 0600 file, same rule as
 * the vault. Never in settings.json, which `/api/settings` would hand to any
 * local caller.
 */
export class WebhookStore {
  private dir: string;
  private keychain: AlertKeychain;
  private cache: { url?: string } | undefined;

  constructor(dir: string, keychain: AlertKeychain) {
    this.dir = dir;
    this.keychain = keychain;
  }

  private file(): string {
    return join(this.dir, 'alert-webhook');
  }

  get(): string | undefined {
    if (this.cache) return this.cache.url;
    let url: string | undefined;
    if (this.keychain.available()) url = this.keychain.get(KEY);
    if (!url) {
      try {
        url = existsSync(this.file()) ? readFileSync(this.file(), 'utf8').trim() || undefined : undefined;
      } catch {
        url = undefined;
      }
    }
    this.cache = { url };
    return url;
  }

  set(url: string | null): void {
    this.cache = undefined;
    if (url === null) {
      if (this.keychain.available()) this.keychain.delete(KEY);
      rmSync(this.file(), { force: true });
      return;
    }
    if (this.keychain.available() && this.keychain.set(KEY, url)) {
      rmSync(this.file(), { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(), url, { mode: 0o600 });
  }
}

export interface AlerterDeps {
  notify(title: string, body: string): boolean;
  /** POST JSON; resolves to whether the receiver answered 2xx. */
  post(url: string, body: Record<string, unknown>): Promise<boolean>;
  webhook(): { url?: string; format: AlertWebhookFormat };
  origin: AlertOrigin;
  home: string;
  /** How long to gather events into one alert. */
  windowMs: number;
  log(line: string): void;
}

/**
 * Coalesces watcher events into one notification and one webhook call per
 * window, so `brew install` landing five tools, or a harness writing three keys
 * at once, is one alert rather than a burst.
 */
export class Alerter {
  private deps: AlerterDeps;
  private queue: WatchEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: AlerterDeps) {
    this.deps = deps;
  }

  add(events: WatchEvent[]): void {
    if (!events.length) return;
    this.queue.push(...events);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.deps.windowMs);
  }

  /** Send whatever is queued now. Returns what each channel said. */
  async flush(): Promise<{ notified: boolean; webhook?: boolean }> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.queue.splice(0);
    if (!events.length) return { notified: false };
    const n = notificationFor(events, this.deps.home);
    const notified = n ? this.deps.notify(n.title, n.body) : false;
    const { url, format } = this.deps.webhook();
    let webhook: boolean | undefined;
    if (url) {
      try {
        webhook = await this.deps.post(url, webhookBody(format, events, this.deps.origin));
      } catch {
        webhook = false;
      }
      // Never the URL itself in a log line: it is a credential for that channel.
      if (!webhook) this.deps.log(`[alerts] the team webhook did not accept ${events.length} event(s)`);
    }
    return { notified, webhook };
  }

  /** A test alert through both channels, on demand. */
  async test(): Promise<{ notified: boolean; webhook?: boolean }> {
    const notified = this.deps.notify('Hypergate test alert', 'Alerts from this machine will look like this.');
    const { url, format } = this.deps.webhook();
    if (!url) return { notified };
    const sample: WatchEvent = {
      id: 'test',
      at: new Date().toISOString(),
      kind: 'cli-new',
      tool: 'example-cli',
      location: '~/.local/bin',
      source: 'user-bin',
    };
    try {
      return { notified, webhook: await this.deps.post(url, webhookBody(format, [sample], this.deps.origin, true)) };
    } catch {
      return { notified, webhook: false };
    }
  }
}
