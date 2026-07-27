//! Start the tray agent at login, on all three platforms.
//!
//! Each OS has exactly one idiomatic per-user mechanism, and we use it rather
//! than a system-wide one: a login item runs as the user, with their `PATH`,
//! home dir and keychain, which is the whole reason Hypergate is a logon agent
//! and not a service. Nothing here needs elevation.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Registry value name (Windows) / label (macOS) / file stem (Linux).
const NAME: &str = "Hypergate";
#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "macos")]
const LABEL: &str = "app.hypergate.tray";

/// The command a login item should run: this binary, in tray mode.
fn tray_command() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("could not resolve this executable: {e}"))
}

pub fn enable() -> Result<(), String> {
    let exe = tray_command()?;
    platform::enable(&exe)
}

pub fn disable() -> Result<(), String> {
    platform::disable()
}

pub fn is_enabled() -> bool {
    platform::is_enabled()
}

/// Whether autostart is implemented for the current platform. Unlike the old
/// daemon behaviour (`startupSupported: false` off Windows) this is now true
/// everywhere, but the flag stays so an unknown target degrades honestly.
pub fn is_supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos", target_os = "linux"))
}

// ── Windows: HKCU Run key ───────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    /// `reg.exe` with explicit argv (never a shell string), so a path with
    /// spaces or quotes cannot turn into command injection.
    fn reg(args: &[&str]) -> Result<std::process::Output, String> {
        Command::new("reg")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("reg.exe failed: {e}"))
    }

    pub fn enable(exe: &Path) -> Result<(), String> {
        let value = format!("\"{}\" tray", exe.display());
        let out = reg(&["ADD", RUN_KEY, "/v", NAME, "/t", "REG_SZ", "/d", &value, "/f"])?;
        if !out.status.success() {
            return Err(format!(
                "could not write the Run key: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        // A missing value is success: disable() is idempotent.
        let _ = reg(&["DELETE", RUN_KEY, "/v", NAME, "/f"])?;
        Ok(())
    }

    pub fn is_enabled() -> bool {
        reg(&["QUERY", RUN_KEY, "/v", NAME])
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

// ── macOS: a per-user LaunchAgent ───────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn plist_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{LABEL}.plist"))
    }

    /// XML-escape a path before embedding it in the plist.
    fn esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    }

    pub fn enable(exe: &Path) -> Result<(), String> {
        let path = plist_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create LaunchAgents: {e}"))?;
        }
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>tray</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
            esc(&exe.display().to_string())
        );
        std::fs::write(&path, plist).map_err(|e| format!("could not write the LaunchAgent: {e}"))?;
        // Best-effort load; the plist alone is enough for the next login.
        let _ = Command::new("launchctl")
            .args(["load", "-w"])
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        let path = plist_path();
        if path.exists() {
            let _ = Command::new("launchctl")
                .args(["unload", "-w"])
                .arg(&path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            std::fs::remove_file(&path).map_err(|e| format!("could not remove the LaunchAgent: {e}"))?;
        }
        Ok(())
    }

    pub fn is_enabled() -> bool {
        plist_path().exists()
    }
}

// ── Linux: XDG autostart ────────────────────────────────────────────────────
#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::*;

    fn desktop_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("autostart")
            .join("hypergate.desktop")
    }

    pub fn enable(exe: &Path) -> Result<(), String> {
        let path = desktop_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create the autostart dir: {e}"))?;
        }
        // Exec fields are unquoted-with-escapes per the Desktop Entry spec;
        // backslash and space both need escaping.
        let exec = exe.display().to_string().replace('\\', "\\\\").replace(' ', "\\ ");
        let entry = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name={NAME}\n\
             Comment=Local-first runtime and gateway for MCP servers\n\
             Exec={exec} tray\n\
             Terminal=false\n\
             X-GNOME-Autostart-enabled=true\n"
        );
        std::fs::write(&path, entry).map_err(|e| format!("could not write the autostart entry: {e}"))?;
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        let path = desktop_path();
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("could not remove the autostart entry: {e}"))?;
        }
        Ok(())
    }

    pub fn is_enabled() -> bool {
        desktop_path().exists()
    }
}
