//! Capped persistent diagnostics for Finder-launched tray sessions.
//!
//! The shell still mirrors every line to stderr for terminal launches, while
//! retaining enough local context to diagnose a background app with no console.

use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 1024 * 1024;
static FILE: OnceLock<Mutex<File>> = OnceLock::new();

#[macro_export]
macro_rules! diagnostic {
    ($($arg:tt)*) => {
        $crate::logging::line(format!($($arg)*))
    };
}

pub fn path() -> PathBuf {
    crate::paths::data_dir().join("hypergate.log")
}

pub fn init() {
    let path = path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::metadata(&path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false) {
        let _ = File::create(&path);
    }
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = FILE.set(Mutex::new(file));
    }
}

pub fn line(message: String) {
    let message = redact(&message);
    eprintln!("{message}");
    if let Some(file) = FILE.get() {
        if let Ok(mut file) = file.lock() {
            if file.metadata().map(|m| m.len() >= MAX_BYTES).unwrap_or(false) {
                let _ = file.set_len(0);
                let _ = file.seek(SeekFrom::Start(0));
            }
            let _ = writeln!(file, "{message}");
            let _ = file.flush();
        }
    }
}

fn redact(message: &str) -> String {
    let mut safe = message.to_string();
    if let Ok(token) = std::env::var("HYPERGATE_TOKEN")
        && !token.is_empty()
    {
        safe = safe.replace(&token, "[redacted]");
    }
    for key in ["token", "password", "secret", "authorization", "api_key"] {
        let mut search_from = 0;
        while let Some(relative) = safe[search_from..].to_ascii_lowercase().find(key) {
            let start = search_from + relative;
            let value_start = safe[start + key.len()..]
                .find(|c: char| c == '=' || c == ':' || c.is_ascii_whitespace())
                .map(|i| start + key.len() + i + 1);
            let Some(value_start) = value_start else {
                break;
            };
            let value_end = safe[value_start..]
                .find(|c: char| c.is_ascii_whitespace() || c == ',' || c == '"' || c == '\'')
                .map(|i| value_start + i)
                .unwrap_or(safe.len());
            if value_end > value_start {
                safe.replace_range(value_start..value_end, "[redacted]");
            }
            search_from = value_start + "[redacted]".len();
        }
    }
    safe
}
