import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault, type VaultKeychain } from './vault.js';

const noKeychain: VaultKeychain = {
  available: () => false,
  get: () => undefined,
  set: () => false,
  delete: () => false,
};

const fakeKeychain = (): VaultKeychain & { entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    available: () => true,
    get: (k) => entries.get(k),
    set: (k, v) => {
      entries.set(k, v);
      return true;
    },
    delete: (k) => entries.delete(k),
  };
};

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'hypergate-vault-'));

describe('CredentialVault', () => {
  it('creates, lists (masked, valueless), and reads back a value from the file fallback', () => {
    const dir = freshDir();
    const vault = new CredentialVault(dir, noKeychain);
    const meta = vault.create({ name: 'Fly.io API token', value: 'fly_v1_abcdefghijk', service: 'fly' });

    expect(meta.id).toBe('fly-io-api-token');
    expect(meta.envVar).toBe('FLY_API_TOKEN'); // defaulted from the guide
    expect(meta.hint).toBe('fly_…hijk');
    expect(vault.storage()).toBe('file');

    // Nothing list() returns carries the value, and the metadata file never holds it.
    const listed = JSON.stringify(vault.list());
    expect(listed.includes('fly_v1_abcdefghijk')).toBe(false);
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8').includes('fly_v1_abcdefghijk')).toBe(false);

    expect(vault.value('fly-io-api-token')).toBe('fly_v1_abcdefghijk');
  });

  it('mints unique ids for colliding names', () => {
    const vault = new CredentialVault(freshDir(), noKeychain);
    expect(vault.create({ name: 'Token', value: 'a' }).id).toBe('token');
    expect(vault.create({ name: 'Token', value: 'b' }).id).toBe('token-2');
  });

  it('rejects a malformed env var and a blank value', () => {
    const vault = new CredentialVault(freshDir(), noKeychain);
    expect(() => vault.create({ name: 'x', value: 'v', envVar: 'not valid' })).toThrow(/envVar/);
    expect(() => vault.create({ name: 'x', value: '   ' })).toThrow(/value/);
  });

  it('roll replaces the value in place and stamps rotatedAt without changing the id', () => {
    const vault = new CredentialVault(freshDir(), noKeychain);
    const meta = vault.create({ name: 'Vercel token', value: 'old_value_123456' });
    const rolled = vault.roll(meta.id, 'new_value_654321')!;
    expect(rolled.id).toBe(meta.id);
    expect(rolled.rotatedAt).toBeDefined();
    expect(rolled.hint).toBe('new_…4321');
    expect(vault.value(meta.id)).toBe('new_value_654321');
    expect(vault.roll('missing', 'v')).toBeUndefined();
  });

  it('delete removes the metadata row and the stored value', () => {
    const dir = freshDir();
    const vault = new CredentialVault(dir, noKeychain);
    const meta = vault.create({ name: 'Doomed', value: 'v' });
    const file = join(dir, 'credentials', `${meta.id}.json`);
    expect(existsSync(file)).toBe(true);
    expect(vault.delete(meta.id)).toBe(true);
    expect(vault.get(meta.id)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(vault.value(meta.id)).toBeUndefined();
    expect(vault.delete(meta.id)).toBe(false);
  });

  it('uses the keychain when available and cleans it on delete', () => {
    const kc = fakeKeychain();
    const dir = freshDir();
    const vault = new CredentialVault(dir, kc);
    const meta = vault.create({ name: 'GitHub PAT', value: 'ghp_1234567890abcd', service: 'github' });
    expect(vault.storage()).toBe('keychain');
    expect(kc.entries.get(`cred:${meta.id}`)).toBe('ghp_1234567890abcd');
    // No plaintext fallback file exists when the keychain took the write.
    expect(existsSync(join(dir, 'credentials', `${meta.id}.json`))).toBe(false);
    expect(vault.value(meta.id)).toBe('ghp_1234567890abcd');
    vault.delete(meta.id);
    expect(kc.entries.has(`cred:${meta.id}`)).toBe(false);
  });

  it('envFor resolves canonical vars plus guide aliases and reports which ids answered', () => {
    const vault = new CredentialVault(freshDir(), noKeychain);
    const gh = vault.create({ name: 'GitHub PAT', value: 'ghp_x', service: 'github' });
    vault.create({ name: 'No env var', value: 'v', envVar: undefined, service: undefined });
    const { env, used } = vault.envFor([gh.id, 'no-env-var', 'missing']);
    expect(env.GH_TOKEN).toBe('ghp_x');
    expect(env.GITHUB_TOKEN).toBe('ghp_x');
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_x');
    expect(used).toEqual([gh.id]);
    expect(vault.get(gh.id)?.lastUsedAt).toBeDefined();
  });
});
