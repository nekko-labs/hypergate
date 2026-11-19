import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchEvent } from '@hypergate/shared';
import { Alerter, WebhookStore, notificationFor, validateWebhookUrl, webhookBody, webhookHint } from './alerts.js';

const ev = (kind: WatchEvent['kind'], tool: string, extra: Partial<WatchEvent> = {}): WatchEvent => ({
  id: tool,
  at: '2026-11-19T10:00:00.000Z',
  kind,
  tool,
  location: '/home/u/.zshrc',
  ...extra,
});
const origin = { host: 'mac', user: 'philip', platform: 'darwin', version: '1.0.0' };

describe('alert payloads', () => {
  it('one event names it; several are summarised', () => {
    expect(notificationFor([ev('ambient-new', 'Shell startup file', { detail: 'OPENAI_API_KEY' })], '/home/u')).toEqual({
      title: 'Hypergate: New login outside the vault',
      body: 'Shell startup file (OPENAI_API_KEY) in ~/.zshrc',
    });
    expect(notificationFor([ev('ambient-new', 'a'), ev('cli-new', 'b'), ev('cli-new', 'c')])?.body).toBe(
      '1 login outside the vault and 2 new command-line tools. Open Hypergate to review.',
    );
    expect(notificationFor([ev('ambient-imported', 'a')])).toBeUndefined();
  });

  it('webhook bodies carry only value-free fields', () => {
    const e = { ...ev('ambient-new', 'Codex CLI', { detail: 'API key' }), hint: 'sk-p…2345', value: 'sk-secret' } as unknown as WatchEvent;
    for (const format of ['json', 'slack'] as const) {
      const s = JSON.stringify(webhookBody(format, [e], origin));
      expect(s).not.toContain('sk-');
      expect(s).toContain('Codex CLI');
    }
    const json = webhookBody('json', [e], origin) as { events: Record<string, unknown>[]; host: string };
    expect(Object.keys(json.events[0]).sort()).toEqual(['at', 'detail', 'kind', 'location', 'tool']);
    expect(json.host).toBe('mac');
    expect(Object.keys(webhookBody('slack', [e], origin))).toEqual(['text']);
  });

  it('webhook URLs must be https unless local, and are only ever shown masked', () => {
    expect(validateWebhookUrl('https://hooks.slack.com/services/T/B/XYZ')).toContain('https://');
    expect(validateWebhookUrl('http://localhost:9000/hook')).toContain('localhost');
    expect(() => validateWebhookUrl('http://example.com/hook')).toThrow(/https/);
    expect(() => validateWebhookUrl('file:///etc/passwd')).toThrow();
    expect(webhookHint('https://hooks.slack.com/services/T/B/SECRETXYZ')).toBe('hooks.slack.com/…TXYZ');
  });
});

describe('WebhookStore', () => {
  it('falls back to a file without a keychain and clears with null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypergate-alerts-'));
    const none = { available: () => false, get: () => undefined, set: () => false, delete: () => false };
    const s = new WebhookStore(dir, none);
    expect(s.get()).toBeUndefined();
    s.set('https://hooks.example.com/x');
    expect(new WebhookStore(dir, none).get()).toBe('https://hooks.example.com/x');
    s.set(null);
    expect(new WebhookStore(dir, none).get()).toBeUndefined();
  });
});

describe('Alerter', () => {
  it('coalesces a burst into one notification and one webhook call', async () => {
    const notes: string[] = [];
    const posts: unknown[] = [];
    const a = new Alerter({
      notify: (t) => (notes.push(t), true),
      post: async (_u, b) => (posts.push(b), true),
      webhook: () => ({ url: 'https://hooks.example.com/x', format: 'json' }),
      origin,
      home: '/home/u',
      windowMs: 60_000,
      log: () => {},
    });
    a.add([ev('cli-new', 'a')]);
    a.add([ev('cli-new', 'b')]);
    expect(await a.flush()).toEqual({ notified: true, webhook: true });
    expect(notes).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(await a.flush()).toEqual({ notified: false });
  });

  it('a failing webhook is reported without the URL', async () => {
    const logs: string[] = [];
    const a = new Alerter({
      notify: () => false,
      post: async () => { throw new Error('ECONNREFUSED'); },
      webhook: () => ({ url: 'https://hooks.example.com/SECRET', format: 'slack' }),
      origin,
      home: '',
      windowMs: 60_000,
      log: (l) => logs.push(l),
    });
    a.add([ev('cli-new', 'a')]);
    expect(await a.flush()).toEqual({ notified: false, webhook: false });
    expect(logs.join('\n')).not.toContain('SECRET');
  });
});
