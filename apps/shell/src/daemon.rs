//! Launching, waiting for, and stopping the daemon.
//!
//! The shell is a supervisor, not a reimplementation: it spawns `hypergated`
//! and then talks to it over the same HTTP API the web UI uses. The daemon
//! stays independently runnable, so headless Linux, WSL and containers need no
//! shell at all.

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::{api, paths};

/// Records the pid of a daemon we launched, so a later `hypergate stop` can
/// find it. We deliberately do *not* add a shutdown route to the daemon: the
/// management API is currently unauthenticated on localhost, and a kill switch
/// reachable from any local process (or a page exploiting the wildcard CORS
/// header) would be worse than needing a pid file.
fn pid_file() -> PathBuf {
    paths::data_dir().join("daemon.pid")
}

fn write_pid(pid: u32) {
    let _ = fs::create_dir_all(paths::data_dir());
    let _ = fs::write(pid_file(), pid.to_string());
}

fn read_pid() -> Option<u32> {
    fs::read_to_string(pid_file()).ok()?.trim().parse().ok()
}

fn clear_pid() {
    let _ = fs::remove_file(pid_file());
}

/// Build the daemon command, inheriting our environment so managed servers see
/// the user's real `PATH`, home dir and credentials. This is precisely why
/// Hypergate is a per-user logon agent and not a system service.
fn command() -> Result<Command, String> {
    let (program, args) = paths::daemon_command().ok_or_else(|| {
        "could not find the daemon: set HYPERGATE_DAEMON_CMD, put `hypergated` on PATH, \
         or build apps/daemon (npm run build)"
            .to_string()
    })?;
    let mut cmd = Command::new(program);
    cmd.args(args);
    Ok(cmd)
}

/// Spawn the daemon as our child, so it exits when the tray does.
pub fn spawn_child() -> Result<Child, String> {
    let mut cmd = command()?;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the daemon is a background service, so never flash
        // a console window when the tray starts it.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start the daemon: {e}"))?;
    write_pid(child.id());
    drain(&mut child);
    Ok(child)
}

/// Forward the daemon's stdout/stderr to ours on background threads.
///
/// Not cosmetic: piped output nobody reads fills the OS pipe buffer and then
/// blocks the daemon on its next write. Draining also means `hypergate tray`
/// run from a terminal shows daemon errors instead of swallowing them.
fn drain(child: &mut Child) {
    use std::io::{BufRead, BufReader, Write};
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = writeln!(std::io::stderr(), "[hypergated] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = writeln!(std::io::stderr(), "[hypergated] {line}");
            }
        });
    }
}

/// Spawn the daemon fully detached, so it survives this process exiting.
pub fn spawn_detached() -> Result<u32, String> {
    let mut cmd = command()?;
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New session, so the daemon is not killed with our terminal.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let child = cmd.spawn().map_err(|e| format!("could not start the daemon: {e}"))?;
    let pid = child.id();
    write_pid(pid);
    Ok(pid)
}

/// Poll `/health` until the daemon answers or we give up.
pub fn wait_until_up(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if api::is_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

/// Stop a daemon this shell started. Returns whether anything was stopped.
pub fn stop() -> Result<bool, String> {
    let Some(pid) = read_pid() else {
        return Ok(false);
    };
    kill(pid)?;
    // Give it a moment to release its port and SQLite handles before reporting done.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && api::is_up() {
        std::thread::sleep(Duration::from_millis(100));
    }
    clear_pid();
    Ok(true)
}

/// Terminate a process and its children.
fn kill(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        // /T takes the whole tree: the daemon's managed MCP servers are its
        // children, and leaving them orphaned is exactly the leak the
        // sandbox-exec Job Object fixes for the supervised case.
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("taskkill failed: {e}"))?;
        if !status.success() {
            return Err(format!("could not stop pid {pid} (already gone?)"));
        }
    }
    #[cfg(unix)]
    {
        // Negative pid = the process group created by setsid() above.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    Ok(())
}
