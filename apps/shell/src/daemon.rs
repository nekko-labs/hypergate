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
/// find it.
///
/// The daemon does have a shutdown route now (the manager UI's Stop button), but
/// it is guarded by the master gateway token *and* a same-origin check, since
/// the management API otherwise answers with a wildcard CORS header and an unguarded
/// kill switch would be reachable from any page the user happens to visit. The
/// pid path stays because it needs no token and still works when the daemon is
/// wedged and no longer answering HTTP at all.
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
    // Tell the daemon where we are, so it never has to guess. It can work this
    // out for itself (see `locate` in apps/daemon/src/shell.ts), but only for
    // layouts it knows: a global npm install puts `hypergate.cmd` on PATH and
    // the real binary inside the platform package, so a PATH scan alone finds
    // nothing and one-click updates quietly stop working. When we started the
    // daemon, the answer is simply our own path.
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("HYPERGATE_SHELL_BIN", exe);
    }
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
    use std::io::{BufRead, BufReader};
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                crate::diagnostic!("[hypergated] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                crate::diagnostic!("[hypergated] {line}");
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
        detach_our_std_handles();
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

/// Stop our own stdin/stdout/stderr from being inherited by the daemon.
///
/// Windows `CreateProcess` inherits *every* inheritable handle, not just the
/// ones named in `STARTUPINFO`, so a detached daemon would hold open the pipes
/// of whatever launched `hypergate start` even though its own stdio is NUL. A
/// caller that captures output (a script, CI, `execFileSync`) then waits for an
/// EOF that only arrives when the daemon exits, which is never, that being the
/// point of a daemon. Clearing the inherit flag costs us nothing: we keep using
/// these handles ourselves, we just stop handing them down.
#[cfg(windows)]
fn detach_our_std_handles() {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAGS, SetHandleInformation};

    let handles = [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ];
    for raw in handles {
        if raw.is_null() {
            continue;
        }
        // Best effort: a redirected-to-NUL or already-closed handle is fine.
        unsafe {
            let _ = SetHandleInformation(HANDLE(raw), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));
        }
    }
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

/// Probe whether a supervised daemon process still exists without spawning a
/// helper process from the tray.
pub fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal zero probes existence without stopping the process.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
            return false;
        };
        let mut code = 0;
        let alive = unsafe { GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32 };
        unsafe {
            let _ = CloseHandle(handle);
        }
        alive
    }
}

/// Stop a daemon this shell started. Returns whether anything was stopped.
pub fn stop() -> Result<bool, String> {
    let Some(pid) = read_pid() else {
        return Ok(false);
    };
    // The daemon can now exit on its own (the UI's Stop button, or a crash),
    // which leaves our pid file pointing at nothing. Killing that pid would
    // report a failure for a daemon that is already down, so treat it as
    // "nothing to stop" and clear the stale file instead.
    if !api::is_up() {
        clear_pid();
        return Ok(false);
    }
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
        use std::os::windows::process::CommandExt;
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // CREATE_NO_WINDOW: a console child of the console-less tray would
            // otherwise flash a terminal window at the user.
            .creation_flags(0x0800_0000)
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
