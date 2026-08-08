//! OS keychain storage for Hypergate's secrets.
//!
//! Windows Credential Manager, macOS Keychain, and the Linux Secret Service, via
//! the `keyring` crate's native backends. This replaces plaintext files under
//! `~/.hypergate/` for the gateway token and the per-server OAuth grants.
//!
//! The daemon does not link a keychain library itself. Instead:
//!
//!   • the shell reads the token from the keychain and passes it to the daemon as
//!     `HYPERGATE_TOKEN`, which the daemon already prefers over its token file;
//!   • the daemon reaches OAuth grants by shelling out to `hypergate secret`,
//!     one keychain entry per server holding the whole grant blob as JSON, so
//!     it is one subprocess per server per boot rather than one per key.
//!
//! Every path falls back to the legacy files when no keychain exists, which is
//! the normal case on a headless Linux box with no Secret Service running.

use std::fs;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::paths;

/// Base keychain service name. All Hypergate entries live under this.
const SERVICE: &str = "hypergate";
/// Entry name for the master gateway bearer token.
const TOKEN_KEY: &str = "gateway-token";

/// The keychain service to use.
///
/// `HYPERGATE_KEYCHAIN_NAMESPACE` suffixes it, which matters because a keychain
/// is machine-global: unlike `HYPERGATE_DIR`, it is not isolated by data
/// directory. Tests and side-by-side instances set this so they cannot clobber
/// the real user's credentials.
fn service() -> String {
    match std::env::var("HYPERGATE_KEYCHAIN_NAMESPACE") {
        Ok(ns) if !ns.trim().is_empty() => format!("{SERVICE}:{}", ns.trim()),
        _ => SERVICE.to_string(),
    }
}

/// Read a secret from the keychain. `Ok(None)` means "no such entry", which is
/// distinct from "the keychain is broken" (`Err`).
pub fn get(key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&service(), key).map_err(|e| format!("keychain unavailable: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(&service(), key).map_err(|e| format!("keychain unavailable: {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("keychain write failed: {e}"))
}

/// Delete a secret. A missing entry is success, so this is idempotent.
pub fn delete(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(&service(), key).map_err(|e| format!("keychain unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

/// Is a working keychain available on this machine?
pub fn available() -> bool {
    // A round-trip on a throwaway entry is the only honest probe: constructing an
    // Entry succeeds even where no backend can actually store anything.
    let probe = "__hypergate_probe";
    match set(probe, "1") {
        Ok(()) => {
            let ok = matches!(get(probe), Ok(Some(_)));
            let _ = delete(probe);
            ok
        }
        Err(_) => false,
    }
}

/// How long "there is no token yet" is trusted before the keychain is asked
/// again. The token itself never expires while the process lives, so the only
/// repeated reads are the ones that found nothing — during the seconds between
/// launching the daemon and it minting its first token.
const MISS_TTL: Duration = Duration::from_secs(2);

/// The last answer the keychain gave, and when.
fn cache() -> &'static Mutex<Option<(Option<String>, Instant)>> {
    type TokenCache = Mutex<Option<(Option<String>, Instant)>>;
    static CACHE: OnceLock<TokenCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// The master gateway token: keychain first, then the legacy plaintext file.
///
/// Returns `None` when neither exists, which simply means the daemon has never
/// run (it mints the token on first boot).
///
/// Memoised, because every call the shell makes attaches this and the startup
/// poll makes several a second. A keychain read is not a cheap local lookup: on
/// macOS it is a round trip to `securityd`, which is entitled to stop and ask
/// the user whether this binary may have the item — so a per-request read turns
/// a polling loop into an authorization storm and the app stops responding. The
/// lock is held across the read on purpose: concurrent callers wait for one
/// answer instead of racing to ask again.
pub fn gateway_token() -> Option<String> {
    let mut cached = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((value, read_at)) = cached.as_ref()
        && (value.is_some() || read_at.elapsed() < MISS_TTL)
    {
        return value.clone();
    }
    let fresh = read_gateway_token();
    *cached = Some((fresh.clone(), Instant::now()));
    fresh
}

/// Drop the memoised token, so the next call asks the keychain again. Called
/// when the daemon rejects it: a rotation is precisely when a cache must lose.
pub fn forget_gateway_token() {
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn read_gateway_token() -> Option<String> {
    if let Ok(Some(t)) = get(TOKEN_KEY)
        && !t.trim().is_empty()
    {
        return Some(t.trim().to_string());
    }
    if let Ok(raw) = fs::read_to_string(paths::token_file()) {
        let t = raw.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

/// What `adopt_gateway_token` did, so callers can report it accurately.
#[derive(Debug, PartialEq, Eq)]
pub enum Adopted {
    /// Already in the keychain; nothing to do.
    AlreadyStored,
    /// Imported from the legacy plaintext file (which was then removed).
    MigratedFromFile,
    /// No token existed yet; the daemon will mint one on first boot.
    NothingToAdopt,
    /// No usable keychain: the plaintext file stays authoritative.
    NoKeychain,
}

/// Make the keychain authoritative for the gateway token.
///
/// Called before the shell launches the daemon. Once the token is in the
/// keychain we pass it via `HYPERGATE_TOKEN`, so the daemon never re-creates the
/// plaintext file, and we delete the old one.
pub fn adopt_gateway_token() -> Adopted {
    if !available() {
        return Adopted::NoKeychain;
    }
    // Whatever this decides, the memoised answer from before it is stale.
    forget_gateway_token();
    if let Ok(Some(t)) = get(TOKEN_KEY)
        && !t.trim().is_empty()
    {
        // The keychain wins; drop any stale plaintext copy left behind.
        let _ = fs::remove_file(paths::token_file());
        return Adopted::AlreadyStored;
    }
    let file = paths::token_file();
    if let Ok(raw) = fs::read_to_string(&file) {
        let t = raw.trim().to_string();
        if !t.is_empty() && set(TOKEN_KEY, &t).is_ok() {
            let _ = fs::remove_file(&file);
            return Adopted::MigratedFromFile;
        }
    }
    Adopted::NothingToAdopt
}

// Note on key naming: the daemon stores each remote server's OAuth grant blob
// under `oauth:<serverId>` via `hypergate secret set`. The convention lives on
// the daemon side, where the key is built; nothing here needs to know it.
