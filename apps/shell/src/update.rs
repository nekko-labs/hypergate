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
//!    to go quiet, runs the package manager, and starts `hypergate app` again.
//! 3. Everything it does is appended to `~/.hypergate/update.log`, because an
//!    update that fails after the UI has gone away is otherwise invisible.
//!
//! One-click updating is limited to an npm install on purpose. The native
//! installers are not signed yet on Windows or macOS (docs/signing.md), and
//! downloading and running an unsigned installer unattended is worse than
//! pointing the user at the release; the Linux packages need root, which a
//! per-user agent has no business acquiring. Those channels get told what to run
//! instead, by the daemon, in the UI.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

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

/// `hypergate update --apply`: install the newer version and restart Hypergate.
pub fn apply() -> Result<(), String> {
    // First line of the log, before anything can go wrong: the daemon starts us
    // with no stdio at all, so "did it even run" has to be answerable.
    log("apply requested");
    let info = match api::update_check().or_else(|_| api::update()) {
        Ok(i) => i,
        Err(e) => {
            log(&format!("could not ask the daemon about updates: {e}"));
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
        log(&format!("refused a version that doesn't look like one: {latest:?}"));
        return Err(format!(
            "refusing to install a version that doesn't look like one: {latest:?}"
        ));
    }
    if !is_npm_install() {
        let mut msg = String::from("this copy wasn't installed with npm, so it can't be replaced in place");
        if let Some(note) = info.note.as_deref() {
            msg.push_str(&format!("\n{note}"));
        }
        if let Some(cmd) = info.command.as_deref() {
            msg.push_str(&format!("\nrun: {cmd}"));
        }
        log(&msg.replace('\n', " · "));
        return Err(msg);
    }

    let Some(node) = paths::find_on_path("node") else {
        let msg = "node is not on PATH, so the updater cannot run (an npm install of Hypergate always has one; \
                   reinstall with `npm install -g hypergated@latest` by hand)";
        log(msg);
        return Err(msg.to_string());
    };
    let script = write_updater(&latest).inspect_err(|e| log(&format!("could not write the updater: {e}")))?;

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
    cmd.spawn().map_err(|e| {
        log(&format!("could not start the updater: {e}"));
        format!("could not start the updater: {e}")
    })?;
    log(&format!("updater spawned for v{latest} ({})", script.display()));

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

/// Write the updater to the OS temp dir (never the install dir, which is about
/// to be overwritten) and return its path.
fn write_updater(version: &str) -> Result<std::path::PathBuf, String> {
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
import { appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';

const LOG = __LOG__;
const EXE = __EXE__;
const PORT = __PORT__;
const TARGET = '__PACKAGE__@__VERSION__';
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

// `npm` is a .cmd shim on Windows, which cannot be spawned directly.
const args = ['install', '-g', TARGET];
const r = WIN
  ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'npm', ...args], { encoding: 'utf8', windowsHide: true })
  : spawnSync('npm', args, { encoding: 'utf8' });
log(`npm install -g ${TARGET} exited ${r.status}`);
if (r.stdout) log(`stdout: ${r.stdout.trim().slice(-2000)}`);
if (r.stderr) log(`stderr: ${r.stderr.trim().slice(-2000)}`);

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

log(r.status === 0 ? 'update finished' : 'update FAILED, the previous version is still installed');
try { unlinkSync(new URL(import.meta.url)); } catch {}
"#;

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn the_generated_updater_embeds_its_inputs_and_is_valid_javascript() {
        let path = write_updater("0.12.0").expect("write");
        let body = std::fs::read_to_string(&path).expect("read");
        assert!(body.contains("hypergated@0.12.0"), "target version is baked in");
        // Paths are JSON-encoded, so a Windows path cannot break the script with
        // stray backslashes (`C:\Users\…` would otherwise be an escape sequence).
        assert!(!body.contains("__LOG__") && !body.contains("__EXE__") && !body.contains("__PORT__"));
        assert!(body.contains("const LOG = \""), "log path is a quoted string");
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
}
