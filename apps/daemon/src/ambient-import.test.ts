import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAmbient, type AmbientCommand } from '@hypergate/core';
import { CredentialVault } from './vault.js';
import { importAmbient, purgeBackups, type ImportDeps } from './ambient-import.js';

const OPENAI = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const noKeychain = { available: () => false, get: () => undefined, set: () => false, delete: () => false };

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'hypergate-import-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const vault = new CredentialVault(join(root, 'data'), noKeychain);
  const ran: AmbientCommand[] = [];
  const deps: ImportDeps = {
    vault,
    readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
    writeFile: (p, t) => writeFileSync(p, t),
    deleteFile: (p) => rmSync(p, { force: true }),
    run: async (cmd) => {
      ran.push(cmd);
      return cmd.args[1] === 'token' ? { ok: true, stdout: 'gho_fromkeyring0123456789\n' } : { ok: true, stdout: '' };
    },
    backupDir: join(root, 'data', 'ambient-backup'),
    now: () => new Date('2026-11-19T10:00:00Z'),
  };
  const scan = () => scanAmbient({ home, platform: 'linux', env: {}, readFile: deps.readFile });
  return { home, vault, deps, ran, scan, root };
};

describe('importAmbient', () => {
  it('rc file: vault first, then a 0600 backup, then the line replaced by a marker', async () => {
    const { home, vault, deps, scan } = setup();
    const rc = join(home, '.zshrc');
    writeFileSync(rc, `alias x=y\nexport OPENAI_API_KEY="${OPENAI}"\n`);
    const [h] = scan();
    const r = await importAmbient(h, deps);
    expect(r).toMatchObject({ ok: true, vault: 'created', removed: true });
    expect(vault.value(r.credentialId!)).toBe(OPENAI);
    expect(vault.get(r.credentialId!)?.service).toBe('openai');
    expect(readFileSync(rc, 'utf8')).not.toContain(OPENAI);
    expect(readFileSync(rc, 'utf8')).toContain('# hypergate: OPENAI_API_KEY moved to the Hypergate vault on 2026-11-19');
    expect(readFileSync(r.backup!, 'utf8')).toContain(OPENAI);
    if (process.platform !== 'win32') expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(scan()).toHaveLength(0);
  });

  it('a different value never replaces a stored credential; a matching one is reused', async () => {
    const { home, vault, deps, scan } = setup();
    const existing = vault.create({ name: 'OpenAI', value: 'sk-old-0123456789abcdef', service: 'openai' });
    writeFileSync(join(home, '.zshrc'), `export OPENAI_API_KEY=${OPENAI}\n`);
    const r = await importAmbient(scan()[0], deps);
    expect(r).toMatchObject({ vault: 'created' });
    expect(r.credentialId).not.toBe(existing.id);
    expect(vault.value(existing.id)).toBe('sk-old-0123456789abcdef');
    expect(vault.get(r.credentialId!)?.name).toMatch(/\(imported\)$/);
    writeFileSync(join(home, '.bashrc'), `export OPENAI_API_KEY=${OPENAI}\n`);
    const again = await importAmbient(scan()[0], deps);
    expect(again).toMatchObject({ vault: 'unchanged', credentialId: r.credentialId });
  });

  it('gh keyring login: value from `gh auth token`, removal by `gh auth logout`', async () => {
    const { home, vault, deps, ran, scan } = setup();
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    user: octo\n');
    const r = await importAmbient(scan()[0], deps);
    expect(r).toMatchObject({ ok: true, removed: true, vault: 'created' });
    expect(vault.value(r.credentialId!)).toBe('gho_fromkeyring0123456789');
    expect(ran.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['auth token', 'auth logout']);
  });

  it('supabase access-token is backed up and deleted', async () => {
    const { home, deps, scan } = setup();
    mkdirSync(join(home, '.supabase'));
    const file = join(home, '.supabase', 'access-token');
    writeFileSync(file, 'sbp_0123456789abcdef0123');
    const r = await importAmbient(scan()[0], deps);
    expect(r.removed).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(r.backup!)).toBe(true);
  });

  it('detect-only findings are refused without touching anything', async () => {
    const { home, vault, deps, scan } = setup();
    mkdirSync(join(home, '.aws'));
    writeFileSync(join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n');
    const r = await importAmbient(scan()[0], deps);
    expect(r.ok).toBe(false);
    expect(vault.list()).toHaveLength(0);
  });

  it('a file that changed after the scan is left alone, with the value safely in the vault', async () => {
    const { home, vault, deps, scan } = setup();
    const rc = join(home, '.zshrc');
    writeFileSync(rc, `export OPENAI_API_KEY=${OPENAI}\n`);
    const [h] = scan();
    writeFileSync(rc, 'export OPENAI_API_KEY=sk-proj-changed-in-between-123\n');
    const r = await importAmbient(h, deps);
    expect(r).toMatchObject({ ok: true, removed: false });
    expect(r.manualStep).toMatch(/changed since/);
    expect(vault.value(r.credentialId!)).toBe(OPENAI);
  });
});

describe('purgeBackups', () => {
  it('removes backups past the TTL only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypergate-backups-'));
    mkdirSync(join(dir, 'old'));
    mkdirSync(join(dir, 'new'));
    const old = new Date('2026-11-01T00:00:00Z');
    utimesSync(join(dir, 'old'), old, old);
    expect(purgeBackups(dir, new Date())).toBe(1);
    expect(readdirSync(dir)).toEqual(['new']);
  });
});
