import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { Updater } from './updater.ts';

/**
 * The download half of updating: the part that runs while the daemon is still
 * alive, so it is the part that can be tested in-process. Installing belongs to
 * the shell (see apps/shell/src/update.rs) and is covered end to end by
 * `npm run smoke:update`.
 *
 * Everything here runs against a real HTTP server rather than a mocked `fetch`,
 * because the things worth pinning down — a hash that doesn't match, a truncated
 * body, a `.part` file that must not survive — are all properties of a real
 * stream landing on a real disk.
 */

const sha512 = (b: Buffer): string => `sha512-${createHash('sha512').update(b).digest('base64')}`;

let dir: string;
let server: Server;
let base: string;
const bodies: Record<string, Buffer> = {};
/** Serve a body that doesn't match the hash we advertised. */
let corrupt = false;
/** Serve fewer bytes than the asset said it would weigh. */
let truncate = false;
/** Dribble the body out, so progress is observable rather than instantaneous. */
let slow = false;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hypergate-updater-'));
  corrupt = false;
  truncate = false;
  bodies['pkg.tgz'] = randomBytes(40_000);
  bodies['shell.tgz'] = randomBytes(20_000);
  server = createServer(async (req, res) => {
    const name = (req.url ?? '/').slice(1);
    const body = bodies[name];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': String(body.length) }).end();
      return;
    }
    let served = corrupt ? Buffer.concat([Buffer.from([body[0] ^ 0xff]), body.subarray(1)]) : body;
    // A short body with an honest Content-Length: the wire is consistent, and
    // only the size the feed promised says something is missing.
    if (truncate) served = served.subarray(0, served.length - 100);
    res.writeHead(200, { 'Content-Length': String(served.length) });
    if (!slow) {
      res.end(served);
      return;
    }
    for (let i = 0; i < served.length; i += 4096) {
      res.write(served.subarray(i, i + 4096));
      await new Promise((r) => setTimeout(r, 4));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const assets = (opts: { integrity?: boolean; size?: boolean } = {}) => [
  {
    name: 'shell.tgz',
    url: `${base}/shell.tgz`,
    size: opts.size === false ? undefined : bodies['shell.tgz'].length,
    integrity: opts.integrity === false ? undefined : sha512(bodies['shell.tgz']),
  },
  {
    name: 'pkg.tgz',
    url: `${base}/pkg.tgz`,
    size: opts.size === false ? undefined : bodies['pkg.tgz'].length,
    integrity: opts.integrity === false ? undefined : sha512(bodies['pkg.tgz']),
  },
];

describe('Updater', () => {
  it('downloads every asset, verifies it, and marks the version staged', async () => {
    const u = new Updater(dir);
    expect(u.progress().stage).toBe('idle');
    await u.download('1.2.3', assets());

    const p = u.progress();
    expect(p.stage).toBe('staged');
    expect(p.fraction).toBe(1);
    expect(u.staged()?.version).toBe('1.2.3');
    // Order matters: the platform shell installs before the package that
    // depends on it.
    expect(u.stagedFiles('1.2.3').map((f) => f.split(/[\\/]/).pop())).toEqual(['shell.tgz', 'pkg.tgz']);
    for (const [name, body] of Object.entries(bodies)) {
      expect(readFileSync(join(dir, 'updates', '1.2.3', name)).equals(body), name).toBe(true);
    }
  });

  it('reports real progress, and resolves the total from the wire when the feed did not say', async () => {
    slow = true;
    const u = new Updater(dir);
    // No declared sizes, which is what an npm packument gives us: the total has
    // to come from a HEAD, or the bar could never fill.
    const run = u.download('1.2.3', assets({ size: false }));
    const seen: number[] = [];
    while (u.busy()) {
      const p = u.progress();
      if (p.received) seen.push(p.received);
      await new Promise((r) => setTimeout(r, 10));
    }
    await run;
    const total = bodies['pkg.tgz'].length + bodies['shell.tgz'].length;
    expect(u.progress().total).toBe(total);
    // Genuinely incremental, not one jump from nothing to done.
    expect(seen.length).toBeGreaterThan(2);
    expect(Math.max(...seen)).toBeLessThanOrEqual(total);
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1])).toBe(true);
  });

  it('throws away a download whose hash does not match what the feed promised', async () => {
    corrupt = true;
    const u = new Updater(dir);
    await expect(u.download('1.2.3', assets())).rejects.toThrow(/integrity/i);
    expect(u.progress().stage).toBe('error');
    expect(u.staged()).toBeUndefined();
    expect(existsSync(join(dir, 'updates', '1.2.3'))).toBe(false);
  });

  it('throws away a truncated download even when no hash was published', async () => {
    truncate = true;
    const u = new Updater(dir);
    await expect(u.download('1.2.3', assets({ integrity: false }))).rejects.toThrow(/expected .* bytes/);
    expect(u.staged()).toBeUndefined();
  });

  it('joins a run already in flight instead of downloading twice', async () => {
    const u = new Updater(dir);
    const a = u.download('1.2.3', assets());
    const b = u.download('1.2.3', assets());
    expect(b).toBe(a);
    await a;
    // And an already-staged version resolves without touching the network at
    // all, which is what makes "download only" then "install" free.
    await new Promise((r) => server.close(r));
    await u.download('1.2.3', assets());
    expect(u.progress().stage).toBe('staged');
    server = createServer(() => {}).listen(0);
  });

  it('does not mistake a half-finished download for something ready to install', async () => {
    const u = new Updater(dir);
    const d = join(dir, 'updates', '1.2.3');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'pkg.tgz'), 'partial');
    expect(u.staged()).toBeUndefined();
    // A manifest whose files have since gone missing is no better.
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ version: '1.2.3', files: ['gone.tgz'], stagedAt: new Date(0).toISOString() }));
    expect(u.staged()).toBeUndefined();
  });

  it('keeps only the newest staged version', async () => {
    const u = new Updater(dir);
    await u.download('1.2.3', assets());
    await u.download('1.2.4', assets());
    expect(u.staged()?.version).toBe('1.2.4');
    expect(existsSync(join(dir, 'updates', '1.2.3'))).toBe(false);
  });

  it('reports the last update once, then forgets it', () => {
    const u = new Updater(dir);
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      join(dir, 'updates', 'last-result.json'),
      JSON.stringify({ ok: true, version: '1.2.3', finishedAt: new Date(0).toISOString() }),
    );
    expect(u.takeLastResult()?.version).toBe('1.2.3');
    expect(u.takeLastResult()).toBeUndefined();
  });

  it('calls an install that never took the daemon down what it is: a failure', () => {
    const u = new Updater(dir);
    u.installing('1.2.3');
    expect(u.progress().stage).toBe('installing');

    // Being alive to report an install a minute later is itself the evidence:
    // the install replaces this process's own files, so the shell stops it
    // within seconds. A spinner that runs forever is the one answer that helps
    // nobody, so wind the clock back and check it gives up.
    const internals = u as unknown as { state: { startedAt: string } };
    internals.state.startedAt = new Date(Date.now() - 61_000).toISOString();
    expect(u.progress().stage).toBe('error');
    expect(u.progress().error).toMatch(/still running/);
  });

  it('clears a stale failure before starting a new install attempt', () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      join(dir, 'updates', 'last-result.json'),
      JSON.stringify({ ok: false, version: '1.2.3', finishedAt: new Date(0).toISOString(), error: 'old failure' }),
    );
    const u = new Updater(dir);
    u.installing('1.2.3');
    expect(u.progress().stage).toBe('installing');
    expect(existsSync(join(dir, 'updates', 'last-result.json'))).toBe(false);
  });
});
