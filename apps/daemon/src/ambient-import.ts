import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AmbientImportResult, CreateCredentialRequest, CredentialMeta } from '@hypergate/shared';
import { ambientCredentialName, removeAmbient, type AmbientCommand, type AmbientHit } from '@hypergate/core';

/**
 * Moving one ambient credential into the vault: read it, store it, take it out
 * at the source. Order matters and is the safety property: the value is in the
 * vault (and the source file is backed up) **before** anything is removed, so a
 * failure at any step leaves the key somewhere you can still use it.
 */

/** The slice of the vault an import needs. */
export interface ImportVault {
  list(): CredentialMeta[];
  forService(service: string): CredentialMeta | undefined;
  value(id: string): string | undefined;
  create(req: CreateCredentialRequest): CredentialMeta;
  roll(id: string, value: string): CredentialMeta | undefined;
}

export interface ImportDeps {
  vault: ImportVault;
  readFile(path: string): string | undefined;
  /** Rewrite a file in place, keeping its mode. */
  writeFile(path: string, text: string): void;
  deleteFile(path: string): void;
  /** Run a vendor command without a shell. stdout is returned, never logged. */
  run(cmd: AmbientCommand): Promise<{ ok: boolean; stdout: string }>;
  /** `~/.hypergate/ambient-backup`. */
  backupDir: string;
  now(): Date;
  /** Called after a roll, so running servers pick up the new value. */
  rolled?(credentialId: string): Promise<void>;
}

/** How long a backup (which holds the value it backed up) is kept. */
export const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const stampOf = (d: Date): string => d.toISOString().replace(/[:.]/g, '-');

/** A file name for a backed-up path: the path with its separators flattened. */
const backupName = (path: string): string => path.replace(/^[A-Za-z]:/, '').replace(/[\\/]+/g, '_').replace(/^_+/, '');

/** Copy a file into a fresh 0700 backup directory as 0600. Returns the copy's path. */
export const backupFile = (path: string, backupDir: string, now: Date): string => {
  const dir = join(backupDir, stampOf(now));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, backupName(path));
  copyFileSync(path, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    /* Windows: ACLs, not modes; the directory is already under the user profile */
  }
  return dest;
};

/**
 * Delete backups older than the TTL. A backup holds the very value the import
 * took out of the file, so keeping it forever would just move the ambient copy
 * somewhere less obvious.
 */
export const purgeBackups = (backupDir: string, now: Date, ttlMs = BACKUP_TTL_MS): number => {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(backupDir, name);
    try {
      if (now.getTime() - statSync(full).mtimeMs > ttlMs) {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* raced with another purge; fine */
    }
  }
  return removed;
};

/** The vault row an import should land in: same service, else same env var on a custom row. */
const existingFor = (vault: ImportVault, h: AmbientHit): CredentialMeta | undefined => {
  if (h.service) return vault.forService(h.service);
  if (h.envVar) return vault.list().find((r) => !r.service && r.envVar === h.envVar);
  return undefined;
};

export const importAmbient = async (h: AmbientHit, deps: ImportDeps): Promise<AmbientImportResult> => {
  if (!h.importable) return { ok: false, removed: false, manualStep: h.manualStep, error: 'this login cannot be imported' };

  // 1. The value.
  let value = h.value;
  if (value === undefined && h.valueCommand) {
    const out = await deps.run(h.valueCommand);
    value = out.ok ? out.stdout.trim() : undefined;
    if (!value) return { ok: false, removed: false, error: `\`${h.valueCommand.file}\` would not print the token` };
  }
  if (!value) return { ok: false, removed: false, error: 'no value to import' };

  // 2. Into the vault, before anything is removed.
  let credentialId: string;
  let vault: AmbientImportResult['vault'];
  const existing = existingFor(deps.vault, h);
  // Any credential for the same service or env var already holding this exact
  // value (an earlier import, or the key the user stored by hand) is reused.
  const same = deps.vault
    .list()
    .filter((r) => (h.service ? r.service === h.service : !r.service && r.envVar === h.envVar))
    .find((r) => deps.vault.value(r.id) === value);
  if (same) {
    credentialId = same.id;
    vault = 'unchanged';
  } else {
    // A different value never replaces a stored one. Whatever wrote this file
    // runs as the user, agents included, so rolling here would let anything
    // that can edit ~/.zshrc swap the vault's real key for one it chose (and
    // auto-quarantine would do it unattended). A new credential starts with no
    // agent grants, so it changes nothing until a person decides to use it.
    const meta = deps.vault.create({
      name: existing ? `${ambientCredentialName(h)} (imported)` : ambientCredentialName(h),
      value,
      kind: /KEY$/.test(h.envVar ?? '') ? 'api-key' : 'token',
      service: h.service,
      envVar: h.service ? undefined : h.envVar,
      note: `Imported from ${h.location}${h.detail ? ` (${h.detail})` : ''}`,
    });
    credentialId = meta.id;
    vault = 'created';
  }

  // 3. Out of the source.
  const now = deps.now();
  const date = now.toISOString().slice(0, 10);
  if (h.removal === 'manual') return { ok: true, credentialId, vault, removed: false, manualStep: h.manualStep };

  try {
    return await removeAtSource(h, deps, credentialId, vault, now, date);
  } catch (e) {
    // The key is already in the vault; only the source could not be changed
    // (a read-only dotfile, a file another process holds). Say both halves
    // rather than failing as though nothing happened.
    return {
      ok: true,
      credentialId,
      vault,
      removed: false,
      error: `the key is in the vault, but ${h.location} could not be changed (${e instanceof Error ? e.message : 'error'})`,
      manualStep: `Remove ${h.detail ?? 'the value'} from ${h.location} by hand.`,
    };
  }
};

const removeAtSource = async (
  h: AmbientHit,
  deps: ImportDeps,
  credentialId: string,
  vault: AmbientImportResult['vault'],
  now: Date,
  date: string,
): Promise<AmbientImportResult> => {
  if (h.removal === 'vendor-logout' && h.logout) {
    // The vendor's logout rewrites its own file (gh edits hosts.yml), so the
    // file is backed up first like any other edit.
    let backup: string | undefined;
    if (existsSync(h.location)) {
      try {
        backup = backupFile(h.location, deps.backupDir, now);
      } catch (e) {
        return {
          ok: true,
          credentialId,
          vault,
          removed: false,
          error: `could not back up ${h.location}, so the logout was not run (${e instanceof Error ? e.message : 'error'})`,
        };
      }
    }
    const out = await deps.run(h.logout);
    return out.ok
      ? { ok: true, credentialId, vault, removed: true, backup }
      : {
          ok: true,
          credentialId,
          vault,
          removed: false,
          backup,
          manualStep: `Run \`${[h.logout.file, ...h.logout.args].join(' ')}\` yourself; it did not complete from Hypergate.`,
        };
  }
  if (!existsSync(h.location)) return { ok: true, credentialId, vault, removed: true };
  let backup: string;
  try {
    backup = backupFile(h.location, deps.backupDir, now);
  } catch (e) {
    return {
      ok: true,
      credentialId,
      vault,
      removed: false,
      error: `could not back up ${h.location}, so it was left alone (${e instanceof Error ? e.message : 'error'})`,
    };
  }

  if (h.removal === 'delete-file') {
    deps.deleteFile(h.location);
    return { ok: true, credentialId, vault, removed: true, backup };
  }

  const text = deps.readFile(h.location);
  const next = text === undefined ? undefined : removeAmbient(text, h, date);
  if (next === undefined) {
    return {
      ok: true,
      credentialId,
      vault,
      removed: false,
      backup,
      manualStep: `${h.location} changed since it was scanned; remove ${h.detail ?? 'the value'} by hand or sweep again.`,
    };
  }
  deps.writeFile(h.location, next);
  return { ok: true, credentialId, vault, removed: true, backup };
};
