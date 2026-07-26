//! Where things live, and how the shell finds the daemon it supervises.
//!
//! The shell deliberately mirrors the daemon's own conventions (`HYPERGATE_DIR`,
//! `~/.hypergate`, port 7777) rather than inventing its own, so running the
//! daemon by hand and running it under the tray reach the same state.

use std::path::{Path, PathBuf};

/// `~/.hypergate`, or `HYPERGATE_DIR` when set (matches the daemon).
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HYPERGATE_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hypergate")
}

/// The daemon's HTTP port. `HYPERGATE_PORT` then `PORT`, else 7777.
pub fn port() -> u16 {
    for key in ["HYPERGATE_PORT", "PORT"] {
        if let Ok(v) = std::env::var(key) {
            if let Ok(p) = v.trim().parse::<u16>() {
                return p;
            }
        }
    }
    7777
}

/// Base URL of the local daemon.
pub fn base_url() -> String {
    format!("http://localhost:{}", port())
}

/// Legacy plaintext token file. The keychain is preferred (see `secrets`); this
/// remains both the fallback and what an older daemon wrote.
pub fn token_file() -> PathBuf {
    data_dir().join("gateway-token")
}

/// How to launch the daemon. Resolution order:
///
/// 1. `HYPERGATE_DAEMON_CMD` (whitespace-separated), for packaged builds and tests.
/// 2. A `hypergated` executable next to this binary or on `PATH`.
/// 3. `node <repo>/apps/daemon/dist/index.js`, found by walking up from this
///    binary, which is the layout during development.
pub fn daemon_command() -> Option<(String, Vec<String>)> {
    if let Ok(raw) = std::env::var("HYPERGATE_DAEMON_CMD") {
        let mut parts = raw.split_whitespace().map(str::to_string);
        if let Some(cmd) = parts.next() {
            return Some((cmd, parts.collect()));
        }
    }

    if let Some(bin) = find_sibling_or_path("hypergated") {
        return Some((bin.to_string_lossy().into_owned(), vec![]));
    }

    let entry = repo_daemon_entry()?;
    Some((
        "node".to_string(),
        vec![entry.to_string_lossy().into_owned()],
    ))
}

/// `apps/daemon/dist/index.js`, located by walking up from the running binary.
/// Falls back to the current directory so `cargo run` from the crate works.
fn repo_daemon_entry() -> Option<PathBuf> {
    let starts = [
        std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)),
        std::env::current_dir().ok(),
    ];
    for start in starts.into_iter().flatten() {
        let mut dir: Option<&Path> = Some(&start);
        while let Some(d) = dir {
            let candidate = d.join("apps").join("daemon").join("dist").join("index.js");
            if candidate.is_file() {
                return Some(candidate);
            }
            dir = d.parent();
        }
    }
    None
}

/// Look for `name` (with a platform executable extension) beside this binary,
/// then on `PATH`. Shell-free, so nothing here can be turned into an injection.
fn find_sibling_or_path(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .chain(std::iter::once(String::new()))
            .collect()
    } else {
        vec![String::new()]
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(exe_dir);
    }
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }

    for dir in dirs {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
