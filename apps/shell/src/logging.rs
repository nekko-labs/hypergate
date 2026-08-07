use std::fs::{self, File, OpenOptions};
use std::io::Write;
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
    eprintln!("{message}");
    if let Some(file) = FILE.get() {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "{message}");
            let _ = file.flush();
        }
    }
}
