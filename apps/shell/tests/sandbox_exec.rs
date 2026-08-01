//! Integration tests for `hypergate sandbox-exec`.
//!
//! These drive the real built binary as a subprocess, which is the only honest
//! way to test it: on Windows the launcher puts its *own* process into the Job
//! Object (see `sandbox::windows_job::apply`), so an in-process test would
//! sandbox and then terminate the test runner. Running the shipped binary also
//! means we are testing exactly what the supervisor will invoke.

use std::process::Command;

/// Path to the binary cargo just built for this test run.
const BIN: &str = env!("CARGO_BIN_EXE_hypergate");

/// `sh -c` / `cmd /c` wrapper, so one test body works on every platform.
fn shell_args(script: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["cmd".into(), "/c".into(), script.into()]
    } else {
        vec!["sh".into(), "-c".into(), script.into()]
    }
}

/// Run `hypergate sandbox-exec <flags> -- <shell script>`, returning
/// (exit code, stdout, stderr).
fn sandbox_exec(flags: &[&str], script: &str) -> (i32, String, String) {
    let out = Command::new(BIN)
        .arg("sandbox-exec")
        .args(flags)
        .arg("--")
        .args(shell_args(script))
        .output()
        .expect("could not run the hypergate binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    )
}

#[test]
fn runs_the_command_and_propagates_a_success_exit_code() {
    let (code, stdout, _) = sandbox_exec(&[], "echo sandboxed");
    assert_eq!(code, 0, "expected a clean exit");
    assert_eq!(stdout, "sandboxed", "stdout must pass through untouched");
}

#[test]
fn propagates_a_failure_exit_code() {
    // The supervisor needs the child's real code, not a generic failure.
    let (code, _, _) = sandbox_exec(&[], "exit 7");
    assert_eq!(code, 7);
}

#[test]
fn inherits_stdio_so_stdout_and_stderr_stay_separate() {
    // MCP rides on stdio, so the two streams must not be merged or buffered away.
    let (code, stdout, stderr) = sandbox_exec(&[], "echo to-out && echo to-err 1>&2");
    assert_eq!(code, 0);
    assert_eq!(stdout, "to-out");
    assert!(stderr.contains("to-err"), "stderr was: {stderr}");
}

#[test]
fn applies_a_memory_limit_without_breaking_a_modest_command() {
    // 512MB is ample for `echo`; this proves the Job Object / setrlimit setup
    // path succeeds, not that the ceiling bites.
    let (code, stdout, stderr) = sandbox_exec(&["--mem", "512"], "echo limited");
    assert_eq!(code, 0, "stderr was: {stderr}");
    assert_eq!(stdout, "limited");
}

#[cfg(windows)]
#[test]
fn applies_a_cpu_cap_on_windows() {
    let (code, stdout, stderr) = sandbox_exec(&["--cpu", "50"], "echo capped");
    assert_eq!(code, 0, "stderr was: {stderr}");
    assert_eq!(stdout, "capped");
}

#[test]
fn warns_but_continues_when_a_limit_is_unsupported_here() {
    // The flag each platform cannot honour: a warning, and the command still runs.
    let flag = if cfg!(windows) {
        ["--nofile", "64"]
    } else {
        ["--cpu", "50"]
    };
    let (code, stdout, stderr) = sandbox_exec(&flag, "echo still-ran");
    assert_eq!(code, 0);
    assert_eq!(stdout, "still-ran");
    assert!(
        stderr.contains("[sandbox] warning:"),
        "expected a warning, got: {stderr}"
    );
}

#[test]
fn strict_mode_refuses_rather_than_pretending() {
    // A sandbox you think you have is worse than none, so --strict must fail.
    let flag = if cfg!(windows) {
        ["--nofile", "64"]
    } else {
        ["--cpu", "50"]
    };
    let out = Command::new(BIN)
        .arg("sandbox-exec")
        .args(flag)
        .arg("--strict")
        .arg("--")
        .args(shell_args("echo should-not-run"))
        .output()
        .expect("could not run the hypergate binary");
    assert!(!out.status.success(), "strict mode should fail");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("cannot honour the requested sandbox"),
        "stderr was: {stderr}"
    );
    assert!(
        !String::from_utf8_lossy(&out.stdout).contains("should-not-run"),
        "the command must not run when the sandbox cannot be applied"
    );
}

#[test]
fn reports_a_missing_program_clearly() {
    let out = Command::new(BIN)
        .args(["sandbox-exec", "--", "hypergate-no-such-binary-xyz"])
        .output()
        .expect("could not run the hypergate binary");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("could not start"), "stderr was: {stderr}");
}

#[test]
fn requires_a_command_after_the_separator() {
    let out = Command::new(BIN)
        .args(["sandbox-exec"])
        .output()
        .expect("could not run the hypergate binary");
    assert!(!out.status.success(), "a bare sandbox-exec should be rejected");
}

// ── CLI surface ─────────────────────────────────────────────────────────────

#[test]
fn help_lists_every_subcommand() {
    let out = Command::new(BIN)
        .arg("--help")
        .output()
        .expect("could not run the hypergate binary");
    assert!(out.status.success());
    let help = String::from_utf8_lossy(&out.stdout);
    for cmd in [
        "app",
        "tray",
        "start",
        "stop",
        "restart",
        "status",
        "list",
        "logs",
        "open",
        "gateway",
        "update",
        "shortcut",
        "autostart",
        "secret",
        "sandbox-exec",
        "catalog",
        "search",
        "add",
        "rm",
        "server",
        "tools",
        "call",
    ] {
        assert!(help.contains(cmd), "`{cmd}` missing from --help:\n{help}");
    }
}

/// The commands that reach the daemon must fail with a readable message, not a
/// panic or a raw transport error, when nothing is listening.
#[test]
fn server_commands_fail_cleanly_with_no_daemon() {
    for args in [vec!["catalog"], vec!["tools"], vec!["list"], vec!["rm", "nope"]] {
        let out = Command::new(BIN)
            .args(&args)
            .env("HYPERGATE_PORT", "7999")
            .output()
            .expect("could not run the hypergate binary");
        assert!(!out.status.success(), "`{args:?}` should fail with no daemon");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.starts_with("hypergate: "), "`{args:?}` stderr was: {err}");
    }
}

#[test]
fn status_succeeds_even_with_no_daemon_running() {
    // "Is it up?" answered honestly is a successful query, not an error, so this
    // is safe to run in CI where no daemon exists.
    let out = Command::new(BIN)
        .arg("status")
        // Point at a port nothing is listening on.
        .env("HYPERGATE_PORT", "7999")
        .output()
        .expect("could not run the hypergate binary");
    assert!(out.status.success(), "status should exit 0 when the daemon is down");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("not running"), "stdout was: {stdout}");
}
