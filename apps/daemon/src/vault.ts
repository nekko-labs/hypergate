import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateCredentialRequest, CredentialKind, CredentialMeta } from '@hypergate/shared';
import { credentialEnv, credentialSlug, guideForService, isValidEnvVar, maskSecret } from '@hypergate/core';

/**
 * The credential vault's stored half. Values go to the OS keychain (one entry
 * per credential, `cred:<id>`), with the same per-item file fallback the OAuth
 * grants use when there is no keychain (`~/.hypergate/credentials/<id>.json`,
 * mode 0600). Metadata — names, env vars, timestamps, masked hints — lives in
 * `~/.hypergate/credentials.json` and never contains a value.
 *
 * The vault hands a value to exactly three callers, all in the daemon: spawn
 * injection for a managed server's `credentialRefs`, the gateway's
 * `credential_env` builtin for an allowed agent, and `/api/credentials/resolve`
 * for `hypergate run`. The management API only ever sees metadata.
 */

/** Keychain access, injected so tests can run against a fake or files only. */
export interface VaultKeychain {
  available(): boolean;
  get(key: string): string | undefined;
  set(key: string, value: string): boolean;
  delete(key: string): boolean;
}

const credKey = (id: string): string => `cred:${id}`;

export class CredentialVault {
  private rows: CredentialMeta[] | undefined;
  // Plain assignments, not parameter properties: the daemon runs under
  // `node --experimental-strip-types`, which cannot express those.
  private dir: string;
  private keychain: VaultKeychain;

  constructor(dir: string, keychain: VaultKeychain) {
    this.dir = dir;
    this.keychain = keychain;
  }

  private metaPath(): string {
    return join(this.dir, 'credentials.json');
  }
  private valueFile(id: string): string {
    return join(this.dir, 'credentials', `${encodeURIComponent(id)}.json`);
  }

  storage(): 'keychain' | 'file' {
    return this.keychain.available() ? 'keychain' : 'file';
  }

  private load(): CredentialMeta[] {
    if (this.rows) return this.rows;
    try {
      const raw = readFileSync(this.metaPath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.rows = Array.isArray(parsed) ? (parsed as CredentialMeta[]) : [];
    } catch {
      this.rows = [];
    }
    return this.rows;
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.metaPath(), JSON.stringify(this.load(), null, 2));
  }

  list(): CredentialMeta[] {
    return this.load().map((r) => ({ ...r }));
  }

  get(id: string): CredentialMeta | undefined {
    const row = this.load().find((r) => r.id === id);
    return row ? { ...row } : undefined;
  }

  /** The stored credential minted from a guide, when one exists. */
  forService(service: string): CredentialMeta | undefined {
    const row = this.load().find((r) => r.service === service);
    return row ? { ...row } : undefined;
  }

  /** Ids in display order — the roster agent allow-list flips are computed against. */
  ids(): string[] {
    return this.load().map((r) => r.id);
  }

  create(req: CreateCredentialRequest): CredentialMeta {
    const name = req.name.trim();
    if (!name) throw new Error('name required');
    const value = req.value;
    if (typeof value !== 'string' || !value.trim()) throw new Error('value required');
    const envVar = req.envVar?.trim() || undefined;
    if (envVar && !isValidEnvVar(envVar)) throw new Error('envVar must look like FLY_API_TOKEN (A-Z, 0-9, _)');
    const service = req.service?.trim().toLowerCase() || undefined;
    const kind: CredentialKind = req.kind === 'api-key' || req.kind === 'other' ? req.kind : 'token';

    const rows = this.load();
    const stem = credentialSlug(name);
    // `guides` and `resolve` are fixed segments under /api/credentials/, so a
    // credential must never mint them as its id.
    const taken = (candidate: string): boolean =>
      candidate === 'guides' || candidate === 'resolve' || rows.some((r) => r.id === candidate);
    let id = stem;
    for (let n = 2; taken(id); n += 1) id = `${stem}-${n}`;

    const meta: CredentialMeta = {
      id,
      name,
      kind,
      service,
      // A guide-created credential defaults to the guide's canonical env var.
      envVar: envVar ?? (service ? guideForService(service)?.envVar : undefined),
      createdAt: new Date().toISOString(),
      hint: maskSecret(value.trim()),
      note: req.note?.trim() || undefined,
    };
    this.writeValue(id, value.trim());
    rows.push(meta);
    this.save();
    return { ...meta };
  }

  /** Replace the value in place. The id, references, and grants all survive. */
  roll(id: string, value: string): CredentialMeta | undefined {
    const row = this.load().find((r) => r.id === id);
    if (!row) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error('value required');
    this.writeValue(id, value.trim());
    row.rotatedAt = new Date().toISOString();
    row.hint = maskSecret(value.trim());
    this.save();
    return { ...row };
  }

  delete(id: string): boolean {
    const rows = this.load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    rows.splice(idx, 1);
    this.save();
    if (this.keychain.available()) this.keychain.delete(credKey(id));
    try {
      rmSync(this.valueFile(id));
    } catch {
      /* absent is the outcome we wanted */
    }
    return true;
  }

  /**
   * The raw value — internal to the daemon's three doors, never a route's
   * response body. Reads try the keychain first and fall back to the file, so
   * a machine that gains a keychain later still finds older file values.
   */
  value(id: string): string | undefined {
    if (!this.load().some((r) => r.id === id)) return undefined;
    if (this.keychain.available()) {
      const v = this.keychain.get(credKey(id));
      if (v !== undefined && v !== '') return v;
    }
    try {
      const file = this.valueFile(id);
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { value?: string };
        return parsed.value;
      }
    } catch {
      /* corrupt file → treat as missing */
    }
    return undefined;
  }

  private writeValue(id: string, value: string): void {
    if (this.keychain.available() && this.keychain.set(credKey(id), value)) {
      // A keychain write supersedes any older plaintext fallback.
      try {
        rmSync(this.valueFile(id));
      } catch {
        /* fine */
      }
      return;
    }
    mkdirSync(join(this.dir, 'credentials'), { recursive: true });
    writeFileSync(this.valueFile(id), JSON.stringify({ value }), { mode: 0o600 });
  }

  /** Stamp last use. Throttled: a burst of fetches costs one metadata write. */
  touch(id: string): void {
    const row = this.load().find((r) => r.id === id);
    if (!row) return;
    const now = Date.now();
    const last = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
    if (now - last < 60_000) return;
    row.lastUsedAt = new Date(now).toISOString();
    this.save();
  }

  /**
   * Resolve credentials into env for injection. Skips ids with no stored value
   * and credentials with no env var (those are fetchable by id, never ambient).
   */
  envFor(ids: readonly string[]): { env: Record<string, string>; used: string[] } {
    const env: Record<string, string> = {};
    const used: string[] = [];
    for (const id of ids) {
      const row = this.load().find((r) => r.id === id);
      if (!row?.envVar) continue;
      const value = this.value(id);
      if (value === undefined) continue;
      Object.assign(env, credentialEnv(row, value));
      used.push(id);
      this.touch(id);
    }
    return { env, used };
  }
}
