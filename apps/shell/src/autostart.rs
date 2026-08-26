//! Start the tray agent at login, on all three platforms.
//!
//! Each OS has exactly one idiomatic per-user mechanism, and we use it rather
//! than a system-wide one: a login item runs as the user, with their `PATH`,
//! home dir and keychain, which is the whole reason Hypergate is a logon agent
//! and not a service. Nothing here needs elevation.

use std::path::{Path, PathBuf};

/// Registry value name (Windows) / `Name=` in the Linux desktop entry. macOS
/// identifies its login item by `LABEL` instead.
#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
const NAME: &str = "Hypergate";
#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
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
//
// Native registry calls, not `reg.exe`. This used to shell out, and the tray
// polls `is_enabled()` every few seconds: each spawn of a console-subsystem
// child from the console-less tray made Windows allocate a brand-new console
// window, so a terminal flashed (and stole focus) on every poll, and the
// blocking `.output()` on the UI thread froze the open tray menu. An in-process
// API call has none of those failure modes, and there is no argv at all, so
// paths with spaces or quotes cannot become injection either.
#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ, RegCloseKey,
        RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
    };
    use windows::core::{HSTRING, PCWSTR};

    /// An open registry key that closes itself, so no error path can leak it.
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    pub fn enable(exe: &Path) -> Result<(), String> {
        let value = format!("\"{}\" tray", exe.display());
        // UTF-16, with the terminating NUL the registry expects for REG_SZ.
        let mut data: Vec<u16> = value.encode_utf16().collect();
        data.push(0);
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(data.as_ptr().cast(), data.len() * 2) };

        unsafe {
            let mut raw = HKEY::default();
            let rc = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut raw,
                None,
            );
            if rc != ERROR_SUCCESS {
                return Err(format!("could not open the Run key (error {})", rc.0));
            }
            let key = Key(raw);
            let rc = RegSetValueExW(key.0, &HSTRING::from(NAME), None, REG_SZ, Some(bytes));
            if rc != ERROR_SUCCESS {
                return Err(format!("could not write the Run key (error {})", rc.0));
            }
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        unsafe {
            let mut raw = HKEY::default();
            let rc = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                None,
                KEY_SET_VALUE,
                &mut raw,
            );
            if rc == ERROR_FILE_NOT_FOUND {
                return Ok(()); // no Run key at all: nothing to disable
            }
            if rc != ERROR_SUCCESS {
                return Err(format!("could not open the Run key (error {})", rc.0));
            }
            let key = Key(raw);
            let rc = RegDeleteValueW(key.0, &HSTRING::from(NAME));
            // A missing value is success: disable() is idempotent.
            if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
                return Err(format!("could not delete the Run value (error {})", rc.0));
            }
        }
        Ok(())
    }

    pub fn is_enabled() -> bool {
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                &HSTRING::from(NAME),
                RRF_RT_REG_SZ,
                None,
                None,
                None,
            ) == ERROR_SUCCESS
        }
    }
}

// ── macOS: a per-user LaunchAgent ───────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::process::{Command, Stdio};

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

    /// Pull `CFBundleIdentifier` out of an XML `Info.plist`.
    ///
    /// Deliberately not a plist parser: this reads one well-known key out of a
    /// file we generate ourselves (packaging/installers/macos/build-dmg.sh), and
    /// a wrong answer costs a display name rather than correctness. A binary
    /// plist simply yields None and the caller falls back to our own identifier.
    pub(super) fn bundle_id_from_plist(text: &str) -> Option<String> {
        let after_key = text.split("<key>CFBundleIdentifier</key>").nth(1)?;
        let open = after_key.find("<string>")? + "<string>".len();
        let close = after_key[open..].find("</string>")? + open;
        let id = after_key[open..close].trim();
        (!id.is_empty()).then(|| id.to_string())
    }

    /// The app bundle this executable lives inside, if any.
    ///
    /// `/Applications/Hypergate.app/Contents/MacOS/hypergate` → the `.app`. An
    /// npm or Homebrew install puts the same binary on `PATH` with no bundle
    /// around it, and that case must produce no association at all.
    fn enclosing_app(exe: &Path) -> Option<&Path> {
        exe.ancestors()
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")))
    }

    /// The bundle identifier to attribute the login item to.
    ///
    /// Without this, macOS has nothing tying the agent to an app, so System
    /// Settings falls back to the code-signing identity and lists it under the
    /// *team* name ("Nekko Labs LLC") with a generic icon. Naming the bundle is
    /// what makes it read "Hypergate" with the app's own icon. The identifier is
    /// read from the bundle rather than assumed, so a renamed or relocated app
    /// still describes itself correctly; our own identifier is the fallback,
    /// since being inside a `.app` we could not read is still being inside ours.
    fn associated_bundle_id(exe: &Path) -> Option<String> {
        let app = enclosing_app(exe)?;
        let info = std::fs::read_to_string(app.join("Contents").join("Info.plist")).ok();
        Some(
            info.as_deref()
                .and_then(bundle_id_from_plist)
                .unwrap_or_else(|| LABEL.to_string()),
        )
    }

    /// The LaunchAgent XML for one executable. Pure, so the shape is testable
    /// without writing to `~/Library` or owning a signed app bundle.
    pub(super) fn plist_for(exe: &Path, bundle_id: Option<&str>) -> String {
        let associated = bundle_id.map_or(String::new(), |id| {
            format!(
                "\n  <key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>{}</string>\n  </array>",
                esc(id)
            )
        });
        format!(
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
  <key>ProcessType</key><string>Interactive</string>{associated}
</dict>
</plist>
"#,
            esc(&exe.display().to_string())
        )
    }

    pub fn enable(exe: &Path) -> Result<(), String> {
        let path = plist_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create LaunchAgents: {e}"))?;
        }
        let plist = plist_for(exe, associated_bundle_id(exe).as_deref());
        std::fs::write(&path, plist).map_err(|e| format!("could not write the LaunchAgent: {e}"))?;
        let launchctl = |args: &[&str]| {
            let _ = Command::new("launchctl")
                .args(args)
                .arg(&path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        };
        // Unload before loading. `load` on an agent that is already loaded is a
        // no-op, so an upgrade that changes the plist (as adding the bundle
        // association does) would otherwise not take effect until next login.
        //
        // Plain `unload`, deliberately without `-w`: that flag also writes the
        // agent into launchd's disabled overrides, so a `load` that then failed
        // would leave autostart switched off having been asked to switch it on.
        launchctl(&["unload"]);
        // Best-effort load; the plist alone is enough for the next login.
        launchctl(&["load", "-w"]);
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::platform::{bundle_id_from_plist, plist_for};
    use std::path::Path;

    #[test]
    fn the_login_item_names_the_app_bundle_it_belongs_to() {
        let plist = plist_for(
            Path::new("/Applications/Hypergate.app/Contents/MacOS/hypergate"),
            Some("app.hypergate.tray"),
        );
        // Without this key macOS attributes the agent to the signing team, so
        // Login Items reads "Nekko Labs LLC" with a generic icon instead of
        // "Hypergate" with its own.
        assert!(plist.contains("<key>AssociatedBundleIdentifiers</key>"), "{plist}");
        assert!(plist.contains("<string>app.hypergate.tray</string>"), "{plist}");
        // Still valid plist XML with the keys launchd actually needs.
        assert!(plist.contains("<key>RunAtLoad</key><true/>"));
        assert!(plist.trim_end().ends_with("</plist>"));
    }

    #[test]
    fn an_unbundled_binary_claims_no_association() {
        // Installed through npm or Homebrew there is no `.app` to point at, and
        // naming one we are not inside would be a claim we cannot back.
        let plist = plist_for(Path::new("/opt/homebrew/bin/hypergate"), None);
        assert!(!plist.contains("AssociatedBundleIdentifiers"), "{plist}");
        assert!(plist.contains("<string>/opt/homebrew/bin/hypergate</string>"));
    }

    #[test]
    fn a_path_needing_escaping_stays_well_formed() {
        let plist = plist_for(
            Path::new("/Users/a&b/My <App>.app/Contents/MacOS/hypergate"),
            Some("x&y"),
        );
        assert!(plist.contains("/Users/a&amp;b/My &lt;App&gt;.app"), "{plist}");
        assert!(plist.contains("<string>x&amp;y</string>"), "{plist}");
    }

    #[test]
    fn the_bundle_identifier_is_read_from_the_bundle() {
        let info = r#"<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Hypergate</string>
  <key>CFBundleIdentifier</key><string>app.hypergate.tray</string>
</dict></plist>"#;
        assert_eq!(bundle_id_from_plist(info).as_deref(), Some("app.hypergate.tray"));
        // Whitespace between the key and its value is legal plist formatting.
        assert_eq!(
            bundle_id_from_plist("<key>CFBundleIdentifier</key>\n\t<string>a.b.c</string>").as_deref(),
            Some("a.b.c"),
        );
        // A binary plist, or one without the key, answers honestly rather than
        // guessing; the caller falls back to our own identifier.
        assert_eq!(bundle_id_from_plist("bplist00\u{0}\u{1}garbage"), None);
        assert_eq!(bundle_id_from_plist("<key>CFBundleName</key><string>X</string>"), None);
        assert_eq!(
            bundle_id_from_plist("<key>CFBundleIdentifier</key><string></string>"),
            None
        );
    }
}
