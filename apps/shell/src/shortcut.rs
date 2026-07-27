//! Desktop launchers: a Start Menu entry, an optional desktop icon, or the
//! platform equivalent, so turning Hypergate on is a click and not a command.
//!
//! This is deliberately *not* an installer. An installer's job is to put files
//! on a machine that has nothing; these entries point at a binary that is
//! already installed and on `PATH`, which is what `npm install -g hypergated`
//! leaves behind. A real MSI/`.dmg`/`.deb` would call the same code to create
//! the same launcher, so the two are complementary rather than alternatives.
//!
//! Everything here is per-user. No elevation, no shared registry keys, nothing
//! another account can see, matching the per-user logon agent the tray already
//! is.

use std::path::PathBuf;

/// A launcher we manage: what to call it, and where it lives.
pub struct Entry {
    pub label: &'static str,
    pub path: PathBuf,
}

impl Entry {
    pub fn exists(&self) -> bool {
        self.path.exists()
    }
}

/// The binary a launcher should run. `current_exe` rather than a `PATH` lookup:
/// a launcher must keep pointing at the build that created it, even if another
/// copy later shows up earlier on `PATH`.
fn target_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("could not resolve this executable: {e}"))
}

pub fn install(desktop: bool) -> Result<Vec<PathBuf>, String> {
    platform::install(desktop)
}

pub fn uninstall() -> Result<Vec<PathBuf>, String> {
    let mut removed = Vec::new();
    for entry in platform::entries(true)? {
        if entry.exists() {
            platform::remove(&entry)?;
            removed.push(entry.path);
        }
    }
    Ok(removed)
}

pub fn status() -> Result<Vec<Entry>, String> {
    platform::entries(true)
}

// ── Windows: .lnk shortcuts in the Start Menu and on the desktop ─────────────
#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::ffi::{OsStr, c_void};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        CoUninitialize, IPersistFile,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, KF_FLAG_CREATE, SHGetKnownFolderPath, ShellLink,
    };
    use windows::core::{GUID, Interface, PCWSTR};

    const LINK_NAME: &str = "Hypergate.lnk";
    const DESCRIPTION: &str = "Local-first runtime and gateway for MCP servers";

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Resolve a known folder by id rather than composing `%APPDATA%\…` by hand.
    /// On a machine with OneDrive folder redirection (the default on a lot of
    /// Windows 11 installs) the real Desktop is not under the user profile, and
    /// a hand-built path would drop the icon somewhere the user never looks.
    fn known_folder(id: *const GUID) -> Result<PathBuf, String> {
        unsafe {
            let raw = SHGetKnownFolderPath(id, KF_FLAG_CREATE, None)
                .map_err(|e| format!("could not resolve a known folder: {e}"))?;
            let path = raw
                .to_string()
                .map_err(|e| format!("known folder path was not valid UTF-16: {e}"))?;
            CoTaskMemFree(Some(raw.0 as *const c_void));
            Ok(PathBuf::from(path))
        }
    }

    /// COM, initialised for as long as the guard lives. `Drop` rather than a
    /// bare call so an early `?` return can't leave the apartment initialised.
    struct Com;
    impl Com {
        fn init() -> Result<Self, String> {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                    .ok()
                    .map_err(|e| format!("could not initialise COM: {e}"))?;
            }
            Ok(Com)
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub fn entries(_include_optional: bool) -> Result<Vec<Entry>, String> {
        Ok(vec![
            Entry {
                label: "Start Menu",
                path: known_folder(&FOLDERID_Programs)?.join(LINK_NAME),
            },
            Entry {
                label: "Desktop",
                path: known_folder(&FOLDERID_Desktop)?.join(LINK_NAME),
            },
        ])
    }

    /// Write the brand mark next to the rest of our state, so the shortcut has
    /// an icon to point at. The binary itself carries no icon resource yet, and
    /// a `.lnk` can reference any `.ico` on disk.
    fn write_icon() -> Result<PathBuf, String> {
        let dir = crate::paths::data_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let path = dir.join("hypergate.ico");
        std::fs::write(&path, crate::icon::ico_bytes()).map_err(|e| format!("could not write the icon: {e}"))?;
        Ok(path)
    }

    fn create_link(target: &Entry, exe: &Path, icon: &Path) -> Result<(), String> {
        if let Some(dir) = target.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("could not create a shell link: {e}"))?;

            let exe_w = wide(&exe.to_string_lossy());
            let args_w = wide("tray");
            let desc_w = wide(DESCRIPTION);
            let icon_w = wide(&icon.to_string_lossy());
            // Working directory: the user's home, not wherever this ran from.
            // A launcher must not pin a directory that may later be deleted.
            let cwd = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let cwd_w = wide(&cwd.to_string_lossy());

            link.SetPath(PCWSTR(exe_w.as_ptr()))
                .map_err(|e| format!("SetPath: {e}"))?;
            link.SetArguments(PCWSTR(args_w.as_ptr()))
                .map_err(|e| format!("SetArguments: {e}"))?;
            link.SetDescription(PCWSTR(desc_w.as_ptr()))
                .map_err(|e| format!("SetDescription: {e}"))?;
            link.SetIconLocation(PCWSTR(icon_w.as_ptr()), 0)
                .map_err(|e| format!("SetIconLocation: {e}"))?;
            link.SetWorkingDirectory(PCWSTR(cwd_w.as_ptr()))
                .map_err(|e| format!("SetWorkingDirectory: {e}"))?;

            let persist: IPersistFile = link.cast().map_err(|e| format!("IPersistFile: {e}"))?;
            let path_w = wide(&target.path.to_string_lossy());
            persist
                .Save(PCWSTR(path_w.as_ptr()), true)
                .map_err(|e| format!("could not save {}: {e}", target.path.display()))?;
        }
        Ok(())
    }

    pub fn install(desktop: bool) -> Result<Vec<PathBuf>, String> {
        let _com = Com::init()?;
        let exe = target_exe()?;
        let icon = write_icon()?;
        let all = entries(true)?;
        let wanted: Vec<&Entry> = all.iter().filter(|e| desktop || e.label != "Desktop").collect();
        let mut made = Vec::new();
        for entry in wanted {
            create_link(entry, &exe, &icon)?;
            made.push(entry.path.clone());
        }
        Ok(made)
    }

    pub fn remove(entry: &Entry) -> Result<(), String> {
        std::fs::remove_file(&entry.path).map_err(|e| format!("could not remove {}: {e}", entry.path.display()))
    }
}

// ── macOS: a tiny .app bundle so Launchpad and Spotlight can find it ─────────
#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const BUNDLE: &str = "Hypergate.app";

    fn bundle_path() -> PathBuf {
        // ~/Applications, not /Applications: per-user, so no admin prompt.
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Applications")
            .join(BUNDLE)
    }

    pub fn entries(_include_optional: bool) -> Result<Vec<Entry>, String> {
        Ok(vec![Entry {
            label: "Applications",
            path: bundle_path(),
        }])
    }

    pub fn install(_desktop: bool) -> Result<Vec<PathBuf>, String> {
        use std::os::unix::fs::PermissionsExt;

        let exe = target_exe()?;
        let bundle = bundle_path();
        let macos = bundle.join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos).map_err(|e| format!("could not create {}: {e}", macos.display()))?;

        // LSUIElement: an agent with a menu bar item and no Dock icon, which is
        // what the tray already behaves like.
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Hypergate</string>
  <key>CFBundleDisplayName</key><string>Hypergate</string>
  <key>CFBundleIdentifier</key><string>app.hypergate.tray</string>
  <key>CFBundleVersion</key><string>{version}</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Hypergate</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
"#,
            version = env!("CARGO_PKG_VERSION")
        );
        std::fs::write(bundle.join("Contents").join("Info.plist"), plist)
            .map_err(|e| format!("could not write Info.plist: {e}"))?;

        // A stub rather than a copy of the binary: an upgrade in place then
        // needs no re-install, and the bundle can't go stale against it.
        let stub = macos.join("Hypergate");
        std::fs::write(
            &stub,
            format!("#!/bin/sh\nexec {} tray\n", shell_quote(&exe.to_string_lossy())),
        )
        .map_err(|e| format!("could not write the launcher stub: {e}"))?;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not make the launcher executable: {e}"))?;

        Ok(vec![bundle])
    }

    /// Single-quote for `/bin/sh`, so a path with a space or a quote in it
    /// cannot turn the stub into something else.
    fn shell_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', r"'\''"))
    }

    pub fn remove(entry: &Entry) -> Result<(), String> {
        std::fs::remove_dir_all(&entry.path).map_err(|e| format!("could not remove {}: {e}", entry.path.display()))
    }
}

// ── Linux: an XDG desktop entry plus a themed icon ───────────────────────────
#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::*;

    fn data_home() -> PathBuf {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    fn desktop_entry() -> PathBuf {
        data_home().join("applications").join("hypergate.desktop")
    }
    fn icon_file() -> PathBuf {
        data_home()
            .join("icons")
            .join("hicolor")
            .join("scalable")
            .join("apps")
            .join("hypergate.svg")
    }

    pub fn entries(_include_optional: bool) -> Result<Vec<Entry>, String> {
        Ok(vec![
            Entry {
                label: "Applications",
                path: desktop_entry(),
            },
            Entry {
                label: "Icon",
                path: icon_file(),
            },
        ])
    }

    pub fn install(_desktop: bool) -> Result<Vec<PathBuf>, String> {
        let exe = target_exe()?;

        let icon = icon_file();
        if let Some(dir) = icon.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        std::fs::write(&icon, crate::icon::svg()).map_err(|e| format!("could not write the icon: {e}"))?;

        let entry = desktop_entry();
        if let Some(dir) = entry.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        // Exec fields are unquoted-with-escapes per the Desktop Entry spec, the
        // same escaping the autostart entry uses.
        let exec = exe.display().to_string().replace('\\', "\\\\").replace(' ', "\\ ");
        let contents = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=Hypergate\n\
             Comment=Local-first runtime and gateway for MCP servers\n\
             Exec={exec} tray\n\
             Icon=hypergate\n\
             Terminal=false\n\
             Categories=Development;Utility;\n\
             Keywords=MCP;AI;agent;gateway;\n"
        );
        std::fs::write(&entry, contents).map_err(|e| format!("could not write the desktop entry: {e}"))?;

        Ok(vec![entry, icon])
    }

    pub fn remove(entry: &Entry) -> Result<(), String> {
        std::fs::remove_file(&entry.path).map_err(|e| format!("could not remove {}: {e}", entry.path.display()))
    }
}
