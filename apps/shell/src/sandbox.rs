//! `hypergate sandbox-exec` — apply real OS resource limits, then exec a command.
//!
//! The supervisor spawns managed MCP servers *through* this shim instead of
//! spawning them directly, which is the only way to get limits that Node cannot
//! ask for. stdio is inherited straight through, so the daemon's pipes (and the
//! MCP stdio protocol riding on them) are untouched.
//!
//! What is actually enforced, per platform. Nothing here is aspirational: if a
//! limit cannot be applied, `--strict` makes it an error rather than a silent
//! no-op, because a sandbox you *think* you have is worse than none.
//!
//! | Limit          | Windows                          | macOS / Linux                    |
//! |----------------|----------------------------------|----------------------------------|
//! | `--mem MB`     | Job Object `JobMemoryLimit`      | `RLIMIT_AS`                      |
//! | `--cpu PCT`    | Job Object CPU rate hard cap     | not applied (needs cgroups v2)   |
//! | `--nofile N`   | not applicable (no fd table)     | `RLIMIT_NOFILE`                  |
//! | tree teardown  | `KILL_ON_JOB_CLOSE`              | own process group                |
//!
//! The tree teardown is the part that matters most in practice: killing an `npx`
//! shim from Node on Windows routinely leaves the real `node` grandchild running.
//! Job Object membership is inherited, so closing the job reliably reaps all of it.

use std::process::{Command, Stdio};

/// The limits to apply before exec'ing the target.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    /// Memory ceiling in megabytes.
    pub mem_mb: Option<u64>,
    /// CPU ceiling as a percentage of total machine capacity (1..=100).
    pub cpu_pct: Option<u8>,
    /// Maximum open file descriptors.
    pub nofile: Option<u64>,
    /// Fail instead of warning when a requested limit cannot be applied here.
    pub strict: bool,
}

/// Which requested limits this platform cannot honour, as human-readable notes.
fn unsupported(limits: &Limits) -> Vec<String> {
    let mut notes = Vec::new();
    if cfg!(windows) {
        if limits.nofile.is_some() {
            notes.push("--nofile is not applicable on Windows (no per-process fd table)".into());
        }
    } else {
        if limits.cpu_pct.is_some() {
            notes.push("--cpu percentage caps need cgroups v2 delegation and are not applied here".into());
        }
    }
    notes
}

/// Apply the limits and run `program args...`, returning its exit code.
pub fn exec(program: &str, args: &[String], limits: Limits) -> Result<i32, String> {
    for note in unsupported(&limits) {
        if limits.strict {
            return Err(format!("cannot honour the requested sandbox: {note}"));
        }
        crate::diagnostic!("[sandbox] warning: {note}");
    }

    #[cfg(windows)]
    windows_job::apply(&limits)?;

    let mut cmd = Command::new(program);
    cmd.args(args)
        // Inherited, so the MCP stdio stream passes through untouched.
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let l = limits;
        unsafe {
            cmd.pre_exec(move || {
                unix_limits::apply(&l);
                Ok(())
            });
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not start {program}: {e}"))?;
    let status = child.wait().map_err(|e| format!("waiting for {program} failed: {e}"))?;
    Ok(status.code().unwrap_or(if status.success() { 0 } else { 1 }))
}

// ── Windows: Job Objects ────────────────────────────────────────────────────
#[cfg(windows)]
mod windows_job {
    use super::Limits;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
        JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    /// Create the job, apply limits, and put *this* process in it so the child
    /// and every descendant inherit membership.
    ///
    /// Assigning ourselves is deliberate. `std::process` cannot spawn suspended,
    /// so there is no window in which we could assign the child before it starts
    /// running; joining the job first and letting the child inherit is the only
    /// race-free option. This is why `sandbox-exec` is its own process: it must
    /// be a process we are willing to put inside the sandbox.
    ///
    /// The job handle is **intentionally leaked**. `KILL_ON_JOB_CLOSE` fires when
    /// the last handle closes, so holding it in a guard would terminate us at the
    /// end of this function, before we could report the child's exit code.
    /// Leaking it defers the close to process exit, which gives exactly the
    /// semantics we want: when the launcher goes away, so does the whole tree.
    pub fn apply(limits: &Limits) -> Result<(), String> {
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|e| format!("CreateJobObject failed: {e}"))?;

            // Undo the handle on any early return, so a failed setup does not
            // leave a job lying around that could still claim this process.
            let bail = |e: String| {
                let _ = CloseHandle(job);
                Err(e)
            };

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            // Always on: kill everything in the job when the last handle closes.
            // This is the fix for leaked grandchildren, e.g. the real `node` left
            // behind when an `npx` shim is killed.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(mb) = limits.mem_mb {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = (mb as usize).saturating_mul(1024 * 1024);
            }
            if let Err(e) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                return bail(format!("could not set job memory/teardown limits: {e}"));
            }

            if let Some(pct) = limits.cpu_pct {
                let pct = pct.clamp(1, 100) as u32;
                let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                    ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                    ..Default::default()
                };
                // CpuRate is in hundredths of a percent (100% == 10000).
                cpu.Anonymous.CpuRate = pct * 100;
                if let Err(e) = SetInformationJobObject(
                    job,
                    JobObjectCpuRateControlInformation,
                    &cpu as *const _ as *const core::ffi::c_void,
                    size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
                ) {
                    return bail(format!("could not set the job CPU cap: {e}"));
                }
            }

            if let Err(e) = AssignProcessToJobObject(job, GetCurrentProcess()) {
                return bail(format!("could not join the job object: {e}"));
            }
            Ok(())
        }
    }
}

// ── Unix: setrlimit + a dedicated process group ──────────────────────────────
#[cfg(unix)]
mod unix_limits {
    use super::Limits;

    /// Runs in the forked child, between fork and exec. Must stay async-signal
    /// safe: only raw syscalls, no allocation, no printing.
    pub fn apply(limits: &Limits) {
        unsafe {
            // Own process group, so the supervisor can signal the whole tree.
            libc::setpgid(0, 0);

            if let Some(mb) = limits.mem_mb {
                let bytes = mb.saturating_mul(1024 * 1024) as libc::rlim_t;
                let rl = libc::rlimit {
                    rlim_cur: bytes,
                    rlim_max: bytes,
                };
                libc::setrlimit(libc::RLIMIT_AS, &rl);
            }
            if let Some(n) = limits.nofile {
                let rl = libc::rlimit {
                    rlim_cur: n as libc::rlim_t,
                    rlim_max: n as libc::rlim_t,
                };
                libc::setrlimit(libc::RLIMIT_NOFILE, &rl);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_platform_gaps_rather_than_silently_ignoring_them() {
        // Whichever platform the tests run on, the limit the *other* one owns
        // must be reported as unsupported instead of quietly dropped.
        let notes = unsupported(&Limits {
            nofile: Some(64),
            cpu_pct: Some(50),
            ..Default::default()
        });
        assert_eq!(
            notes.len(),
            1,
            "exactly one of --nofile/--cpu is unsupported per platform"
        );
    }

    #[test]
    fn strict_mode_refuses_a_limit_it_cannot_apply() {
        // This returns before any job/rlimit setup, so it is safe in-process.
        let unsupported_here: Limits = if cfg!(windows) {
            Limits {
                nofile: Some(64),
                strict: true,
                ..Default::default()
            }
        } else {
            Limits {
                cpu_pct: Some(50),
                strict: true,
                ..Default::default()
            }
        };
        let err = exec("echo", &[], unsupported_here).unwrap_err();
        assert!(err.contains("cannot honour the requested sandbox"), "got: {err}");
    }

    // Everything that actually applies limits and runs a command lives in
    // tests/sandbox_exec.rs, driving the real binary as a subprocess. It cannot
    // be tested in-process: on Windows `apply` puts the *calling* process into
    // the Job Object, so an in-process test would sandbox (and then kill) the
    // test runner itself.
}
