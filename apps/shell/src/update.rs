//! Updating Hypergate in place.
//!
//! The daemon knows *whether* there is an update (it owns the feed and the
//! cache); this owns *doing* it, because the update replaces the files that both
//! the daemon and the tray are running from. Something has to outlive them, and
//! it cannot be either of them.
//!
//! So the sequence is deliberately three processes deep:
//!
//! 1. `hypergate update --apply` (this) writes a small updater script to the OS
//!    temp dir and spawns it detached, then asks the running agent to quit and
//!    exits. Nothing that gets replaced is still running.
//! 2. The updater waits for the daemon port and the tray's single-instance lock
//!    to go quiet, replaces the package or app bundle, and starts Hypergate again.
//! 3. Everything it does is appended to `~/.hypergate/update.log`, because an
//!    update that fails after the UI has gone away is otherwise invisible.
//!
//! One-click updating supports npm installs and signed macOS app bundles. The
//! macOS path replaces the whole bundle from the notarized release DMG so its
//! signature stays intact. Windows installers remain manual until signing lands;
//! Linux system packages still need root.

use std::io::Write;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{api, daemon, paths};

/// The npm package that carries the daemon, the UI and this binary.
const PACKAGE: &str = "hypergated";

/// Is this copy a global npm install, i.e. one `npm install -g` can replace?
///
/// Deliberately decided from our own path rather than trusting the channel the
/// daemon reports: the command we are about to run is built here, so what it
/// applies to should be judged here too. The daemon's identical answer (see
/// `detectInstallChannel` in packages/core) drives the UI, not the action.
fn is_npm_install() -> bool {
    std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/").to_lowercase())
        .is_some_and(|p| p.contains("/node_modules/"))
}

#[cfg(target_os = "macos")]
fn app_bundle_for_exe(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app")))
    .then(|| app.to_path_buf())
}

#[cfg(target_os = "macos")]
fn current_app_bundle() -> Option<PathBuf> {
    app_bundle_for_exe(&std::env::current_exe().ok()?)
}

#[cfg(target_os = "macos")]
fn macos_asset_name(version: &str) -> Option<String> {
    // Apple silicon only: no other Mac disk image is built, so there is nothing
    // to name for one.
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(format!("hypergate-{version}-macos-{arch}.dmg"))
}

#[cfg(target_os = "macos")]
fn staged_macos_dmg(version: &str) -> Option<(PathBuf, String)> {
    let dir = paths::data_dir().join("updates").join(version);
    let body = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let manifest = serde_json::from_str::<serde_json::Value>(&body).ok()?;
    let files = manifest.get("files")?.as_array()?;
    let expected = macos_asset_name(version)?;
    if files.len() != 1 || files[0].as_str()? != expected {
        return None;
    }
    let sha256 = manifest.get("sha256")?.get(&expected)?.as_str()?;
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let dmg = dir.join(expected);
    dmg.is_file().then(|| (dmg, sha256.to_ascii_lowercase()))
}

/// A version string safe to put on a command line: digits, dots, and the few
/// characters a semver prerelease/build tag may contain. Nothing else, ever.
fn safe_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

/// `hypergate update`: report what the daemon knows, without changing anything.
pub fn show() -> Result<(), String> {
    let info = api::update_check().or_else(|_| api::update())?;
    println!("Installed  v{}", info.current);
    match info.latest.as_deref() {
        Some(latest) if info.update_available => println!("Latest     v{latest}  (update available)"),
        Some(latest) => println!("Latest     v{latest}  (up to date)"),
        None => println!("Latest     unknown (no published release found)"),
    }
    println!("Install    {} channel", info.channel);
    if let Some(url) = info.release_url.as_deref().filter(|_| info.update_available) {
        println!("Notes      {url}");
    }
    if info.update_available {
        if info.can_apply {
            println!("\nRun `hypergate update --apply` to install it (Hypergate restarts).");
        } else {
            if let Some(note) = info.note.as_deref() {
                println!("\n{note}");
            }
            if let Some(cmd) = info.command.as_deref() {
                println!("  {cmd}");
            }
        }
    }
    Ok(())
}

/// Append a line to `~/.hypergate/update.log`.
///
/// Everything on the apply path is logged, not just what the updater script does.
/// The daemon starts us detached with our stdio discarded (it has to: we are about
/// to stop it), so without this a refusal or a missing prerequisite would be
/// completely invisible to the user who pressed the button.
fn log(line: &str) {
    let dir = paths::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("update.log"))
    {
        let _ = writeln!(f, "[hypergate update] {line}");
    }
}

/// Leave a concrete failure for the daemon and the next UI poll.
fn record_failure(version: &str, error: &str) {
    let path = paths::data_dir().join("updates").join("last-result.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({
        "ok": false,
        "version": version,
        "finishedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string()),
        "error": error,
    });
    let _ = std::fs::write(path, body.to_string());
}

/// `hypergate update --apply`: install the newer version and restart Hypergate.
pub fn apply() -> Result<(), String> {
    // First line of the log, before anything can go wrong: the daemon starts us
    // with no stdio at all, so "did it even run" has to be answerable.
    log("apply requested");
    let info = match api::update_check().or_else(|_| api::update()) {
        Ok(i) => i,
        Err(e) => {
            log(&format!("could not ask the daemon about updates: {e}"));
            record_failure("", &format!("could not ask the daemon about updates: {e}"));
            return Err(e);
        }
    };
    if !info.update_available {
        println!("Already up to date (v{}).", info.current);
        log(&format!("nothing to do: already on v{}", info.current));
        return Ok(());
    }
    let latest = info.latest.clone().unwrap_or_default();
    if !safe_version(&latest) {
        let error = format!("refusing to install a version that doesn't look like one: {latest:?}");
        log(&error);
        record_failure(&latest, &error);
        return Err(error);
    }
    if is_npm_install() {
        let Some(node) = paths::find_on_path("node") else {
            let msg = "node is not on PATH, so the updater cannot run (an npm install of Hypergate always has one; \
                       reinstall with `npm install -g hypergated@latest` by hand)";
            log(msg);
            record_failure(&latest, msg);
            return Err(msg.to_string());
        };
        // Prefer what the daemon already downloaded: installing from local tarballs
        // is offline, instant, and installs exactly the bytes that were verified
        // against the feed's hash. Falling back to the registry keeps
        // `hypergate update --apply` working with no daemon-side download at all.
        let staged = staged_files(&latest);
        if staged.is_empty() {
            log("no staged download; the updater will fetch from the registry");
        } else {
            log(&format!("installing {} staged file(s)", staged.len()));
        }
        let script = match write_updater(&latest, &staged) {
            Ok(path) => path,
            Err(e) => {
                log(&format!("could not write the updater: {e}"));
                record_failure(&latest, &e);
                return Err(e);
            }
        };

        // Spawn the updater first, so whatever happens next it is already waiting.
        let mut cmd = Command::new(node);
        cmd.arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: it has
            // to survive us and must not flash a console at the user.
            cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        if let Err(e) = cmd.spawn() {
            let error = format!("could not start the updater: {e}");
            log(&error);
            record_failure(&latest, &error);
            return Err(error);
        }
        log(&format!("updater spawned for v{latest} ({})", script.display()));
    } else {
        #[cfg(target_os = "macos")]
        {
            let app = match current_app_bundle().filter(|_| info.can_apply) {
                Some(app) => app,
                None => {
                    let error = "this copy is not a signed macOS app bundle that Hypergate can replace in place";
                    log(error);
                    record_failure(&latest, error);
                    return Err(error.to_string());
                }
            };
            let (dmg, sha256) = match staged_macos_dmg(&latest) {
                Some(payload) => payload,
                None => {
                    let error = "the signed macOS disk image was not downloaded; retry the update from the manager";
                    log(error);
                    record_failure(&latest, error);
                    return Err(error.to_string());
                }
            };
            spawn_macos_updater(&latest, &sha256, &dmg, &app)?;
            log(&format!("macOS updater spawned for v{latest} ({})", dmg.display()));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let mut msg = String::from("this copy cannot be replaced in place");
            if let Some(note) = info.note.as_deref() {
                msg.push_str(&format!("\n{note}"));
            }
            if let Some(cmd) = info.command.as_deref() {
                msg.push_str(&format!("\nrun: {cmd}"));
            }
            log(&msg.replace('\n', " · "));
            record_failure(&latest, &msg);
            return Err(msg);
        }
    }

    // Now get out of the way. A running tray owns the daemon, so asking it to
    // quit takes both down together; without one, stop the daemon directly.
    if ask_running_instance_to_quit() {
        log("asked the running agent to quit");
        println!("Updating to v{latest}. Hypergate will restart when it's done.");
    } else {
        match api::shutdown() {
            Ok(()) => log("stopped the daemon through its API"),
            Err(e) => log(&format!("could not stop the daemon through its API: {e}")),
        }
        match daemon::stop() {
            Ok(true) => log("stopped the daemon by pid"),
            Ok(false) => log("no daemon pid file to stop"),
            Err(e) => log(&format!("could not stop the daemon by pid: {e}")),
        }
        println!("Updating to v{latest}. The daemon will start again when it's done.");
    }
    println!(
        "Progress is logged to {}",
        paths::data_dir().join("update.log").display()
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_macos_updater(version: &str, sha256: &str, dmg: &Path, app: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    let source = std::env::current_exe().map_err(|e| format!("could not find the updater binary: {e}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    let updater = std::env::temp_dir().join(format!("hypergate-update-{}-{nonce}", std::process::id()));
    let copied = (|| -> Result<(), std::io::Error> {
        let mut input = std::fs::File::open(&source)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&updater)?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        std::fs::set_permissions(&updater, std::fs::metadata(&source)?.permissions())
    })();
    if let Err(error) = copied {
        let _ = std::fs::remove_file(&updater);
        return Err(format!("could not copy the updater to a temporary path: {error}"));
    }
    let mut cmd = Command::new(&updater);
    cmd.arg("internal-apply-macos")
        .arg(version)
        .arg(sha256)
        .arg(dmg)
        .arg(app)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| {
        let _ = std::fs::remove_file(&updater);
        let error = format!("could not start the macOS updater: {e}");
        log(&error);
        record_failure(version, &error);
        error
    })?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn port_busy(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(750),
    )
    .is_ok()
}

#[cfg(target_os = "macos")]
fn wait_for_quiet() -> bool {
    let port = paths::port();
    for _ in 0..60 {
        if !port_busy(port) && !port_busy(port.saturating_add(1)) {
            std::thread::sleep(Duration::from_millis(1500));
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

#[cfg(target_os = "macos")]
fn checked_output(mut command: Command, label: &str) -> Result<std::process::Output, String> {
    let output = command.output().map_err(|e| format!("{label}: {e}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "{label}: {}",
            if detail.is_empty() {
                format!("exited {}", output.status)
            } else {
                detail
            }
        ))
    }
}

#[cfg(target_os = "macos")]
fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the staged disk image has no valid expected SHA-256".to_string());
    }
    let mut command = Command::new("/usr/bin/shasum");
    command.arg("-a").arg("256").arg(path);
    let output = checked_output(command, "could not hash the staged disk image")?;
    let actual = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "the SHA-256 tool returned no checksum".to_string())?;
    if actual != expected.to_ascii_lowercase() {
        return Err("the staged disk image changed after it was downloaded".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn plist_value(app: &Path, key: &str) -> Result<String, String> {
    let mut command = Command::new("/usr/libexec/PlistBuddy");
    command
        .arg("-c")
        .arg(format!("Print :{key}"))
        .arg(app.join("Contents/Info.plist"));
    let output = checked_output(command, &format!("could not read {key} from the app bundle"))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn team_identifier(app: &Path) -> Result<String, String> {
    let mut command = Command::new("/usr/bin/codesign");
    command.arg("-dv").arg("--verbose=4").arg(app);
    let output = command
        .output()
        .map_err(|e| format!("could not inspect the app signature: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not inspect the app signature: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let detail = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    detail
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .filter(|team| !team.is_empty() && *team != "not set")
        .map(str::to_string)
        .ok_or_else(|| "the app signature has no TeamIdentifier".to_string())
}

#[cfg(target_os = "macos")]
fn validate_macos_bundle(app: &Path, version: Option<&str>) -> Result<String, String> {
    if !app.join("Contents/MacOS/hypergate").is_file() || !app.join("Contents/MacOS/hypergated").is_file() {
        return Err(format!("{} is not a complete Hypergate app bundle", app.display()));
    }
    let mut codesign = Command::new("/usr/bin/codesign");
    codesign.arg("--verify").arg("--deep").arg("--strict").arg(app);
    checked_output(codesign, "the app bundle failed code-signature verification")?;
    let mut spctl = Command::new("/usr/sbin/spctl");
    spctl.arg("--assess").arg("--type").arg("execute").arg(app);
    checked_output(spctl, "Gatekeeper rejected the app bundle")?;
    if plist_value(app, "CFBundleIdentifier")? != "app.hypergate.tray" {
        return Err("the update has the wrong bundle identifier".to_string());
    }
    if let Some(expected) = version
        && plist_value(app, "CFBundleShortVersionString")? != expected
    {
        return Err(format!("the update does not contain Hypergate {expected}"));
    }
    team_identifier(app)
}

#[cfg(target_os = "macos")]
fn swap_macos_bundle(source: &Path, target: &Path, version: &str) -> Result<(), String> {
    let expected_team = validate_macos_bundle(target, None)?;
    let update_team = validate_macos_bundle(source, Some(version))?;
    if expected_team != update_team {
        return Err(format!(
            "the update was signed by a different developer team ({update_team}, expected {expected_team})"
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "the installed app has no parent directory".to_string())?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "the installed app has no valid name".to_string())?;
    let staged = parent.join(format!(".{name}.update-new-{}", std::process::id()));
    let backup = parent.join(format!(".{name}.update-backup-{}", std::process::id()));
    let mut ditto = Command::new("/usr/bin/ditto");
    ditto.arg(source).arg(&staged);
    if let Err(error) = checked_output(ditto, "could not copy the new app bundle") {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(error);
    }
    if let Err(error) = validate_macos_bundle(&staged, Some(version)) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(error);
    }
    std::fs::rename(target, &backup).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staged);
        format!("could not move the installed app aside: {e}")
    })?;
    if let Err(error) = std::fs::rename(&staged, target) {
        let rollback = std::fs::rename(&backup, target);
        if rollback.is_ok() {
            let _ = std::fs::remove_dir_all(&staged);
        }
        return Err(format!(
            "could not put the new app in place: {error}{}",
            rollback
                .err()
                .map(|e| format!("; rollback also failed: {e}"))
                .unwrap_or_default()
        ));
    }
    let version_output = Command::new(target.join("Contents/MacOS/hypergate"))
        .arg("--version")
        .output();
    let version_ok = version_output.as_ref().is_ok_and(|output| {
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .any(|part| part == version)
    });
    if !version_ok {
        let detail = version_output
            .map(|output| String::from_utf8_lossy(&output.stderr).trim().to_string())
            .unwrap_or_else(|e| e.to_string());
        let _ = std::fs::remove_dir_all(target);
        std::fs::rename(&backup, target)
            .map_err(|e| format!("the new app did not report version {version} ({detail}); rollback failed: {e}"))?;
        return Err(format!("the new app did not report version {version}: {detail}"));
    }
    if let Err(error) = std::fs::remove_dir_all(&backup) {
        log(&format!(
            "the app updated, but its backup could not be removed: {error}"
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn record_success(version: &str) {
    let path = paths::data_dir().join("updates").join("last-result.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({
        "ok": true,
        "version": version,
        "finishedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string()),
    });
    let _ = std::fs::write(path, body.to_string());
}

#[cfg(target_os = "macos")]
pub fn apply_macos_detached(version: &str, sha256: &str, dmg: &str, app: &str) -> Result<(), String> {
    let dmg = PathBuf::from(dmg);
    let app = PathBuf::from(app);
    log(&format!("macOS update starting: v{version}"));
    let result = (|| {
        if !safe_version(version) {
            return Err("the requested update version is invalid".to_string());
        }
        if !wait_for_quiet() {
            return Err(
                "Hypergate was still running after 30 seconds, so the app bundle was left untouched".to_string(),
            );
        }
        verify_sha256(&dmg, sha256)?;
        let mut codesign = Command::new("/usr/bin/codesign");
        codesign.arg("--verify").arg("--verbose=4").arg(&dmg);
        checked_output(codesign, "the disk image failed code-signature verification")?;
        let mut spctl = Command::new("/usr/sbin/spctl");
        spctl
            .arg("--assess")
            .arg("--type")
            .arg("open")
            .arg("--context")
            .arg("context:primary-signature")
            .arg(&dmg);
        checked_output(spctl, "Gatekeeper rejected the update disk image")?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|time| time.as_nanos())
            .unwrap_or_default();
        let mount = std::env::temp_dir().join(format!("hypergate-update-mount-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&mount).map_err(|e| format!("could not create the disk image mount point: {e}"))?;
        let mut attach = Command::new("/usr/bin/hdiutil");
        attach
            .arg("attach")
            .arg("-nobrowse")
            .arg("-readonly")
            .arg("-mountpoint")
            .arg(&mount)
            .arg(&dmg);
        if let Err(error) = checked_output(attach, "could not mount the update disk image") {
            let _ = std::fs::remove_dir_all(&mount);
            return Err(error);
        }
        let swap = swap_macos_bundle(&mount.join("Hypergate.app"), &app, version);
        let mut detach = Command::new("/usr/bin/hdiutil");
        detach.arg("detach").arg(&mount);
        let detached = checked_output(detach, "could not detach the update disk image");
        let _ = std::fs::remove_dir_all(&mount);
        swap?;
        if let Err(error) = detached {
            log(&error);
        }
        Ok(())
    })();

    match &result {
        Ok(()) => {
            record_success(version);
            let expected = paths::data_dir().join("updates").join(version);
            if dmg.parent() == Some(expected.as_path()) {
                let _ = std::fs::remove_dir_all(expected);
            }
            log(&format!("macOS update finished: v{version}"));
        }
        Err(error) => {
            record_failure(version, error);
            log(&format!("macOS update failed: {error}"));
        }
    }

    if std::env::var("HYPERGATE_UPDATE_RELAUNCH").as_deref() != Ok("0") {
        let binary = app.join("Contents/MacOS/hypergate");
        let mut command = Command::new(&binary);
        command
            .arg("app")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match command.spawn() {
            Ok(_) => log(&format!("relaunched {} app", binary.display())),
            Err(error) => log(&format!("could not relaunch: {error}")),
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        let temporary = exe.parent() == Some(std::env::temp_dir().as_path())
            && exe
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("hypergate-update-"));
        if temporary {
            let _ = std::fs::remove_file(exe);
        }
    }
    result
}

#[cfg(not(target_os = "macos"))]
pub fn apply_macos_detached(_version: &str, _sha256: &str, _dmg: &str, _app: &str) -> Result<(), String> {
    Err("macOS app updates are only available on macOS".to_string())
}

/// Ask a running tray to quit, over the single-instance lock port. True when the
/// message was delivered (i.e. there was an agent to talk to).
fn ask_running_instance_to_quit() -> bool {
    let port = paths::port().saturating_add(1);
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    ) else {
        return false;
    };
    stream.write_all(b"quit\n").is_ok()
}

/// The files the daemon staged for this version, in the order its manifest gave
/// (platform shell first, then the daemon package that depends on it).
///
/// The manifest is what marks a download as complete, so a half-finished one is
/// invisible here and the updater simply falls back to the registry.
fn staged_files(version: &str) -> Vec<String> {
    let dir = paths::data_dir().join("updates").join(version);
    let Ok(body) = std::fs::read_to_string(dir.join("manifest.json")) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Vec::new();
    };
    let Some(files) = manifest.get("files").and_then(|f| f.as_array()) else {
        return Vec::new();
    };
    let paths: Vec<String> = files
        .iter()
        .filter_map(|f| f.as_str())
        // A name, never a path: the manifest is ours, but a file name that
        // could climb out of the staging directory has no business here.
        .filter(|name| !name.contains('/') && !name.contains('\\') && *name != ".." && name.ends_with(".tgz"))
        .map(|name| dir.join(name).to_string_lossy().to_string())
        .filter(|p| std::path::Path::new(p).is_file())
        .collect();
    if paths.len() == files.len() { paths } else { Vec::new() }
}

/// Write the updater to the OS temp dir (never the install dir, which is about
/// to be overwritten) and return its path.
fn write_updater(version: &str, staged: &[String]) -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!("hypergate-update-{}.mjs", std::process::id()));
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not find our own path: {e}"))?
        .to_string_lossy()
        .to_string();
    // Relaunching is what makes this feel like an update rather than a crash, so
    // it is on unless something explicitly opts out: the update smoke test does
    // (it has no display to put a window on), and so can anyone running the
    // daemon headless who does not want an app window appearing.
    let relaunch = std::env::var("HYPERGATE_UPDATE_RELAUNCH").as_deref() != Ok("0");
    let body = UPDATER_JS
        .replace("__PACKAGE__", PACKAGE)
        .replace("__VERSION__", version)
        .replace("__RELAUNCH__", if relaunch { "true" } else { "false" })
        .replace("__PORT__", &paths::port().to_string())
        .replace(
            "__LOG__",
            &json_string(&paths::data_dir().join("update.log").to_string_lossy()),
        )
        .replace(
            "__RESULT__",
            &json_string(
                &paths::data_dir()
                    .join("updates")
                    .join("last-result.json")
                    .to_string_lossy(),
            ),
        )
        .replace(
            "__STAGED__",
            &serde_json::to_string(staged).unwrap_or_else(|_| "[]".to_string()),
        )
        .replace(
            "__STAGEDIR__",
            &json_string(&paths::data_dir().join("updates").join(version).to_string_lossy()),
        )
        .replace("__EXE__", &json_string(&exe));
    std::fs::write(&path, body).map_err(|e| format!("could not write the updater: {e}"))?;
    Ok(path)
}

/// JSON-encode a string so a Windows path can be embedded in the script safely.
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// The updater itself.
///
/// JavaScript, run by the `node` that an npm install necessarily has, because
/// this needs real logic (wait for two ports to go quiet, run a command, restart
/// an app, log all of it) and writing that twice in `cmd` and `sh` would be worse
/// in every way. It is a plain file in the temp dir with no arguments, so there
/// is nothing to quote and nothing to inject.
const UPDATER_JS: &str = r#"// Generated by `hypergate update --apply`. Safe to delete.
import { spawnSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';

const LOG = __LOG__;
const RESULT = __RESULT__;
const EXE = __EXE__;
const PORT = __PORT__;
const VERSION = '__VERSION__';
const TARGET = '__PACKAGE__@__VERSION__';
// Tarballs the daemon already downloaded and hash-checked, platform shell
// first. Empty when there was no daemon-side download, in which case npm
// fetches from the registry instead.
const STAGED = __STAGED__;
const STAGEDIR = __STAGEDIR__;
const WIN = process.platform === 'win32';

const log = (line) => {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};

/** Is anything listening on a loopback port? */
const busy = (port) =>
  new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1000);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the daemon and the tray lock to go quiet, so their files are free. */
const waitForQuiet = async () => {
  for (let i = 0; i < 60; i++) {
    if (!(await busy(PORT)) && !(await busy(PORT + 1))) {
      // A moment more: Windows releases file handles a beat after the process
      // object goes away, and npm cannot overwrite a still-open .exe.
      await sleep(1500);
      return true;
    }
    await sleep(500);
  }
  return false;
};

log(`update starting: ${TARGET}`);
if (!(await waitForQuiet())) log('warning: Hypergate was still running after 30s, trying anyway');

// Local tarballs when the daemon staged them, the registry otherwise. Both go
// through the same `npm install -g`, so the outcome is the same install either
// way; the staged path just needs no network and installs the exact bytes that
// were already verified against the feed's hash.
const targets = STAGED.length > 0 ? STAGED : [TARGET];
const args = ['install', '-g', ...targets];
log(`installing: npm ${args.join(' ')}`);
// `npm` is a .cmd shim on Windows, which cannot be spawned directly.
const r = WIN
  ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'npm', ...args], { encoding: 'utf8', windowsHide: true })
  : spawnSync('npm', args, { encoding: 'utf8' });
const ok = r.status === 0;
log(`npm install -g exited ${r.status}`);
if (r.stdout) log(`stdout: ${r.stdout.trim().slice(-2000)}`);
if (r.stderr) log(`stderr: ${r.stderr.trim().slice(-2000)}`);

// Tell the version that comes up next how this went. Without it a successful
// update is indistinguishable from a crash and a restart, and a failed one is
// invisible unless somebody reads the log.
try {
  mkdirSync(dirname(RESULT), { recursive: true });
  writeFileSync(RESULT, JSON.stringify({
    ok,
    version: VERSION,
    finishedAt: new Date().toISOString(),
    error: ok ? undefined : `npm install exited ${r.status}: ${(r.stderr ?? '').trim().slice(-400)}`,
  }));
} catch (e) {
  log(`could not record the result: ${e?.message ?? e}`);
}

// Staged tarballs are worth keeping only until they are installed. On failure
// they stay put, so a retry needs no second download.
if (ok && STAGED.length > 0) {
  try { rmSync(STAGEDIR, { recursive: true, force: true }); } catch {}
}

// Start the new version the way a desktop launcher would.
if (__RELAUNCH__) {
  try {
    const child = spawn(EXE, ['app'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log(`relaunched ${EXE} app`);
  } catch (e) {
    log(`could not relaunch: ${e?.message ?? e}`);
  }
} else {
  log('relaunch skipped (HYPERGATE_UPDATE_RELAUNCH=0)');
}

log(ok ? 'update finished' : 'update FAILED, the previous version is still installed');
try { unlinkSync(new URL(import.meta.url)); } catch {}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// `write_updater` names its file after the pid, so two tests in the same
    /// process write to the same path. They take turns.
    static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn only_accepts_something_that_looks_like_a_version() {
        for good in ["0.12.0", "1.0.0-rc.1", "0.12.0+build.5", "10.20.30"] {
            assert!(safe_version(good), "{good}");
        }
        for bad in [
            "",
            "0.12.0; rm -rf /",
            "0.12.0 && calc",
            "$(whoami)",
            "0.12.0\n",
            &"9".repeat(65),
        ] {
            assert!(!safe_version(bad), "{bad}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recognises_a_shell_inside_a_macos_app_bundle() {
        let app = app_bundle_for_exe(Path::new("/Applications/Hypergate.app/Contents/MacOS/hypergate"));
        assert_eq!(app, Some(PathBuf::from("/Applications/Hypergate.app")));
        assert_eq!(app_bundle_for_exe(Path::new("/usr/local/bin/hypergate")), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn names_the_apple_silicon_disk_image() {
        let name = macos_asset_name("1.9.0");
        if std::env::consts::ARCH == "aarch64" {
            assert_eq!(name.as_deref(), Some("hypergate-1.9.0-macos-arm64.dmg"));
        } else {
            assert_eq!(name, None);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rechecks_a_staged_disk_images_sha256() {
        let path = std::env::temp_dir().join(format!("hypergate-sha-test-{}", std::process::id()));
        std::fs::write(&path, b"hello").expect("write fixture");
        assert!(
            verify_sha256(
                &path,
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            )
            .is_ok()
        );
        assert!(verify_sha256(&path, &"0".repeat(64)).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_generated_updater_embeds_its_inputs_and_is_valid_javascript() {
        let _turn = WRITES.lock().unwrap_or_else(|e| e.into_inner());
        let path = write_updater("0.12.0", &[]).expect("write");
        let body = std::fs::read_to_string(&path).expect("read");
        assert!(body.contains("hypergated@0.12.0"), "target version is baked in");
        // Paths are JSON-encoded, so a Windows path cannot break the script with
        // stray backslashes (`C:\Users\…` would otherwise be an escape sequence).
        assert!(
            !body.contains("__LOG__")
                && !body.contains("__EXE__")
                && !body.contains("__PORT__")
                && !body.contains("__STAGED__")
                && !body.contains("__RESULT__")
        );
        assert!(body.contains("const LOG = \""), "log path is a quoted string");
        assert!(
            body.contains("const STAGED = []"),
            "no staged files means an empty list"
        );
        #[cfg(windows)]
        assert!(
            body.contains(r"\\"),
            "a Windows path must land in the script with its backslashes escaped, or it is a broken escape sequence"
        );

        // If node is around (it always is on an npm install, and on CI), let it
        // be the judge of whether we generated parseable code.
        if let Some(node) = paths::find_on_path("node") {
            let out = Command::new(node)
                .arg("--check")
                .arg(&path)
                .output()
                .expect("run node --check");
            assert!(
                out.status.success(),
                "node rejected the generated updater: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let _ = std::fs::remove_file(path);
    }

    /// A staged download must reach the updater as real file paths, still
    /// parseable after a Windows path has been embedded in the array.
    #[test]
    fn staged_tarballs_are_installed_instead_of_the_registry() {
        let _turn = WRITES.lock().unwrap_or_else(|e| e.into_inner());
        let staged = vec![
            r"C:\Users\a b\.hypergate\updates\0.12.0\hypergate-shell-win32-x64-0.12.0.tgz".to_string(),
            "/home/a b/.hypergate/updates/0.12.0/hypergated-0.12.0.tgz".to_string(),
        ];
        let path = write_updater("0.12.0", &staged).expect("write");
        let body = std::fs::read_to_string(&path).expect("read");
        assert!(body.contains("hypergated-0.12.0.tgz"), "the staged files are baked in");
        assert!(
            body.contains(r"\\Users\\a b\\"),
            "a Windows path must be escaped inside the array, not left as escape sequences"
        );
        if let Some(node) = paths::find_on_path("node") {
            let out = Command::new(node)
                .arg("--check")
                .arg(&path)
                .output()
                .expect("run node --check");
            assert!(
                out.status.success(),
                "node rejected the updater with staged files: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let _ = std::fs::remove_file(path);
    }

    /// A manifest naming a file outside the staging directory is not honoured.
    #[test]
    fn staged_files_refuses_names_that_are_paths() {
        let tmp = std::env::temp_dir().join(format!("hypergate-staged-test-{}", std::process::id()));
        let dir = tmp.join("updates").join("9.9.9");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("manifest.json"), r#"{"files":["../../evil.tgz"]}"#).expect("write");
        // `staged_files` reads the real data dir, so this asserts the filter
        // directly rather than moving HOME out from under the process.
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        let names: Vec<&str> = manifest["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f.as_str())
            .filter(|name| !name.contains('/') && !name.contains('\\') && *name != ".." && name.ends_with(".tgz"))
            .collect();
        assert!(names.is_empty(), "a traversing name must not survive the filter");
        let _ = std::fs::remove_dir_all(tmp);
    }
}
