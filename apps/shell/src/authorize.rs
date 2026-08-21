//! Proving who is at the keyboard, for the vault's reveal door.
//!
//! The vault's other three doors hand a value to a *process*, and the token
//! that asked is enough to authorise them. Reveal hands it back to a *person*,
//! and a token cannot tell us that a person is there: the master token sits in
//! the keychain of a machine that may be logged in and unattended, and any
//! local process that can read it could otherwise read every key.
//!
//! So this module asks the OS, which is the only thing that can answer. It is
//! deliberately a separate `hypergate authorize` subcommand rather than a
//! library call: the daemon is Node and cannot link LocalAuthentication or WinRT,
//! and keeping the answer behind a process boundary means the daemon can only
//! *ask*, never approve on the user's behalf.
//!
//! # Exit codes
//!
//! The daemon reads these, so they are the contract:
//!
//! - `0` authorized. The user proved themselves just now.
//! - `1` denied. A prompt appeared and the answer was no (or it was cancelled,
//!   or it timed out). Fail closed.
//! - `3` unavailable. This machine has no consent prompt to show, which is a
//!   different answer and reads differently in the UI: the reveal button is
//!   disabled with a reason rather than offered and refused.
//!
//! Nothing here ever falls back to a weaker check. A password typed into our own
//! window would be a Hypergate password, not the OS's, and it would prove less
//! than nothing while looking like security.

/// What a machine can do about proving its user's identity.
///
/// Every variant is constructed on exactly one platform, so on any given build
/// two of them are unreachable by definition. They stay in one enum anyway
/// because the daemon parses the whole set from one string, and splitting them
/// per platform would put that contract in three places.
#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Method {
    TouchId,
    WindowsHello,
    Polkit,
    None,
}

impl Method {
    /// The wire name the daemon parses out of `authorize --check`.
    pub fn as_str(&self) -> &'static str {
        match self {
            Method::TouchId => "touch-id",
            Method::WindowsHello => "windows-hello",
            Method::Polkit => "polkit",
            Method::None => "none",
        }
    }
}

/// The outcome of asking. `Unavailable` carries why, because "this box has no
/// polkit" is something a user needs told, not a silent no.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Authorized,
    Denied,
    Unavailable(String),
}

impl Verdict {
    /// The process exit code for this verdict. See the module docs.
    pub fn exit_code(&self) -> i32 {
        match self {
            Verdict::Authorized => 0,
            Verdict::Denied => 1,
            Verdict::Unavailable(_) => 3,
        }
    }
}

// ── macOS: LocalAuthentication ──────────────────────────────────────────────

/// Touch ID, or the login password where there is no sensor.
///
/// The policy is `deviceOwnerAuthentication` rather than
/// `deviceOwnerAuthenticationWithBiometrics` on purpose: the stricter one fails
/// outright on a Mac with no Touch ID (a Mac mini, an external keyboard, a
/// sensor that has been disabled), and for this purpose the login password is a
/// perfectly good proof of the person. The system decides which to show.
#[cfg(target_os = "macos")]
pub fn authorize(reason: &str) -> Verdict {
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;
    use std::time::Duration;

    let context = unsafe { LAContext::new() };
    let policy = LAPolicy::DeviceOwnerAuthentication;

    // `canEvaluatePolicy` distinguishes "no way to ask" from "asked and
    // refused", which is the whole point of the Unavailable verdict. The
    // binding maps the ObjC out-parameter onto a Result, so the error is the
    // Err arm rather than a pointer we have to inspect.
    if let Err(err) = unsafe { context.canEvaluatePolicy_error(policy) } {
        return Verdict::Unavailable(err.localizedDescription().to_string());
    }

    // evaluatePolicy is asynchronous and calls back on an internal queue, so the
    // answer comes back over a channel. The prompt is modal to the user, not to
    // us; without the wait the process would exit before they touched anything.
    let (tx, rx) = mpsc::channel::<bool>();
    let reason = objc2_foundation::NSString::from_str(reason);
    let block = block2::RcBlock::new(
        move |success: objc2::runtime::Bool, _err: *mut objc2_foundation::NSError| {
            // A send failure means the receiver timed out and gave up; the user
            // answered a prompt nobody is listening to any more, which is fine.
            let _ = tx.send(success.as_bool());
        },
    );
    unsafe { context.evaluatePolicy_localizedReason_reply(policy, &reason, &block) };

    // Long enough to walk back to the desk. The daemon's own timeout is longer,
    // so this is what actually bounds the wait.
    match rx.recv_timeout(Duration::from_secs(90)) {
        Ok(true) => Verdict::Authorized,
        // Denied, cancelled, or too many failed attempts. All the same answer.
        Ok(false) => Verdict::Denied,
        Err(_) => Verdict::Denied,
    }
}

#[cfg(target_os = "macos")]
pub fn method() -> Method {
    use objc2_local_authentication::{LAContext, LAPolicy};
    let context = unsafe { LAContext::new() };
    if unsafe { context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_ok() {
        Method::TouchId
    } else {
        Method::None
    }
}

// ── Windows: Windows Hello ──────────────────────────────────────────────────

/// Windows Hello (face, fingerprint, or PIN), via the WinRT consent verifier.
#[cfg(windows)]
pub fn authorize(reason: &str) -> Verdict {
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    use windows::core::HSTRING;

    if let Some(detail) = available_detail() {
        return Verdict::Unavailable(detail);
    }

    let message = HSTRING::from(reason);
    let op = match UserConsentVerifier::RequestVerificationAsync(&message) {
        Ok(op) => op,
        Err(e) => return Verdict::Unavailable(format!("Windows Hello could not be asked: {e}")),
    };
    // Compared rather than pattern-matched: these WinRT "enums" are newtypes
    // over i32 with associated constants, not Rust enum variants, so a const
    // pattern is not guaranteed to be usable here while `==` always is.
    match op.get() {
        Ok(result) if result == UserConsentVerificationResult::Verified => Verdict::Authorized,
        // Everything else is a no: Canceled, RetriesExhausted, DeviceBusy,
        // NotConfiguredForUser, DeviceNotPresent, DisabledByPolicy.
        Ok(_) => Verdict::Denied,
        Err(e) => Verdict::Unavailable(format!("Windows Hello failed: {e}")),
    }
}

/// `Some(reason)` when Hello cannot be used here.
#[cfg(windows)]
fn available_detail() -> Option<String> {
    use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
    let availability = match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()) {
        Ok(a) => a,
        Err(e) => return Some(format!("Windows Hello could not be queried: {e}")),
    };
    if availability == UserConsentVerifierAvailability::Available {
        return None;
    }
    Some(
        if availability == UserConsentVerifierAvailability::DeviceNotPresent {
            "no Windows Hello device is set up on this PC"
        } else if availability == UserConsentVerifierAvailability::NotConfiguredForUser {
            "Windows Hello is not set up for this user"
        } else if availability == UserConsentVerifierAvailability::DisabledByPolicy {
            "Windows Hello is disabled by policy"
        } else {
            "Windows Hello is unavailable on this PC"
        }
        .to_string(),
    )
}

#[cfg(windows)]
pub fn method() -> Method {
    if available_detail().is_none() {
        Method::WindowsHello
    } else {
        Method::None
    }
}

// ── Linux: polkit ───────────────────────────────────────────────────────────

/// polkit, which is the closest thing Linux has to a standard "confirm it is
/// you" prompt.
///
/// `pkexec true` is the whole mechanism: polkit shows its own authentication
/// dialog for the request, and a zero exit means the user satisfied it. That is
/// a real check by the system rather than by us, which is the bar this door has
/// to clear.
///
/// Where there is no polkit (a headless box, a minimal container, a session with
/// no authentication agent running) the answer is `Unavailable`. A machine
/// without a way to prove its user does not get a weaker one.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn authorize(_reason: &str) -> Verdict {
    use std::process::{Command, Stdio};

    let Some(pkexec) = which("pkexec") else {
        return Verdict::Unavailable("no pkexec on this system, so there is no way to confirm it is you".into());
    };
    // No authentication agent means pkexec cannot prompt, and would either fail
    // obscurely or (in a text session) try to read the terminal we do not have.
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Verdict::Unavailable(
            "no graphical session, so polkit has no way to show an authentication prompt".into(),
        );
    }
    match Command::new(pkexec)
        .arg("/bin/true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => Verdict::Authorized,
        // 126 is polkit's "not authorized", 127 "dismissed". Both are a no.
        Ok(_) => Verdict::Denied,
        Err(e) => Verdict::Unavailable(format!("pkexec could not run: {e}")),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn method() -> Method {
    let graphical = std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    if which("pkexec").is_some() && graphical {
        Method::Polkit
    } else {
        Method::None
    }
}

/// Find a program on `PATH`. Shell-free, like the rest of the shell's lookups.
#[cfg(all(unix, not(target_os = "macos")))]
fn which(program: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::{Method, Verdict};

    #[test]
    fn exit_codes_are_the_contract_the_daemon_reads() {
        // The daemon distinguishes these three, so they must not collide: 0 is
        // the only door-opening answer, and 3 has to be separable from 1 so the
        // UI can say "not available here" instead of "you were refused".
        assert_eq!(Verdict::Authorized.exit_code(), 0);
        assert_eq!(Verdict::Denied.exit_code(), 1);
        assert_eq!(Verdict::Unavailable("no polkit".into()).exit_code(), 3);
    }

    #[test]
    fn method_names_match_what_the_daemon_parses() {
        // These strings are parsed by shell.ts's authorizeCapability; changing
        // one silently turns a working prompt into "unavailable" in the UI.
        assert_eq!(Method::TouchId.as_str(), "touch-id");
        assert_eq!(Method::WindowsHello.as_str(), "windows-hello");
        assert_eq!(Method::Polkit.as_str(), "polkit");
        assert_eq!(Method::None.as_str(), "none");
    }

    #[test]
    fn this_platform_reports_a_method_without_prompting() {
        // `method()` must be cheap and silent: the daemon calls it to build every
        // /api/settings response, so a version that showed a Touch ID sheet
        // would prompt on page load. Only assert it answers and does not hang.
        let m = super::method();
        assert!(matches!(
            m,
            Method::TouchId | Method::WindowsHello | Method::Polkit | Method::None
        ));
    }
}
