//! `hypergate notify` — show one OS notification, for the daemon's watcher.
//!
//! The daemon cannot raise a notification itself (Node has no API for it), so
//! it calls this, the same way it calls `authorize` for consent prompts. Each
//! platform uses the mechanism that works from a background login item, where
//! there is no terminal and often no app bundle to attribute a banner to:
//!
//! | Platform | Mechanism                                                         |
//! |----------|-------------------------------------------------------------------|
//! | macOS    | `osascript` `display notification` (works from a LaunchAgent)      |
//! | Linux    | `notify-send` (freedesktop notifications over D-Bus)               |
//! | Windows  | a PowerShell toast through `Windows.UI.Notifications`              |
//!
//! Text is passed as data, never spliced into a script: argv for `osascript`
//! (`on run argv`) and `notify-send`, environment variables for PowerShell
//! (read with `CreateTextNode`, so nothing in a title can become XML).
//!
//! Exit codes, for the daemon: 0 shown, 1 the mechanism failed, 3 this machine
//! has no way to show one.

use std::process::{Command, Stdio};

/// Strip control characters and cap the length. A notification is one or two
/// short lines; anything else in it is either a mistake or an attempt to make
/// a banner say something the caller did not.
pub fn clean(text: &str, cap: usize) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let collapsed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    // A leading dash would read as an option to notify-send or osascript.
    let trimmed = collapsed.trim_start_matches('-').trim().to_string();
    if trimmed.chars().count() <= cap {
        trimmed
    } else {
        let mut out: String = trimmed.chars().take(cap.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// A command to run: program, arguments, extra environment.
pub type Plan = (String, Vec<String>, Vec<(String, String)>);

/// The program, arguments and extra environment that show one notification on
/// `os`. Split out from `show` so the tests can check it without a desktop.
pub fn plan(os: &str, title: &str, body: &str) -> Option<Plan> {
    match os {
        "macos" => Some((
            "osascript".into(),
            vec![
                "-e".into(),
                "on run argv".into(),
                "-e".into(),
                "display notification (item 2 of argv) with title (item 1 of argv)".into(),
                "-e".into(),
                "end run".into(),
                title.into(),
                body.into(),
            ],
            vec![],
        )),
        "linux" | "freebsd" | "openbsd" | "netbsd" => Some((
            "notify-send".into(),
            vec!["--app-name=Hypergate".into(), "--".into(), title.into(), body.into()],
            vec![],
        )),
        "windows" => Some((
            "powershell.exe".into(),
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-WindowStyle".into(),
                "Hidden".into(),
                "-Command".into(),
                WINDOWS_TOAST.into(),
            ],
            vec![
                ("HYPERGATE_NOTIFY_TITLE".into(), title.into()),
                ("HYPERGATE_NOTIFY_BODY".into(), body.into()),
            ],
        )),
        _ => None,
    }
}

/// Toast through the WinRT API, attributed to PowerShell's registered app id
/// (an unpackaged app has no AppUserModelID of its own to show a toast under).
const WINDOWS_TOAST: &str = "$ErrorActionPreference = 'Stop'; \
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; \
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \
$x = $t.GetElementsByTagName('text'); \
$x.Item(0).AppendChild($t.CreateTextNode($env:HYPERGATE_NOTIFY_TITLE)) > $null; \
$x.Item(1).AppendChild($t.CreateTextNode($env:HYPERGATE_NOTIFY_BODY)) > $null; \
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))";

/// Show one notification. Returns the exit code described in the module docs.
pub fn show(title: &str, body: &str) -> i32 {
    let title = clean(title, 80);
    let body = clean(body, 240);
    let Some((program, args, envs)) = plan(std::env::consts::OS, &title, &body) else {
        eprintln!("notifications are not supported on {}", std::env::consts::OS);
        return 3;
    };
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => 0,
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            eprintln!("{program} could not show the notification: {}", err.trim());
            1
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("{program} is not installed, so this machine cannot show notifications");
            3
        }
        Err(e) => {
            eprintln!("could not run {program}: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_controls_dashes_and_caps() {
        assert_eq!(clean("--hello\nworld\t!", 80), "hello world !");
        assert_eq!(clean("abcdef", 4), "abc…");
        assert_eq!(clean("  ", 10), "");
    }

    #[test]
    fn macos_passes_text_as_argv_not_script() {
        let (program, args, _) = plan("macos", "T \" & quit", "B").unwrap();
        assert_eq!(program, "osascript");
        assert_eq!(args[args.len() - 2], "T \" & quit");
        assert!(args.iter().take(6).all(|a| !a.contains("quit")));
    }

    #[test]
    fn linux_ends_options_before_the_text() {
        let (program, args, _) = plan("linux", "-t", "b").unwrap();
        assert_eq!(program, "notify-send");
        let dashdash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(&args[dashdash + 1..], ["-t", "b"]);
    }

    #[test]
    fn windows_passes_text_through_the_environment() {
        let (_, args, envs) = plan("windows", "<x/>", "b").unwrap();
        assert!(args.iter().all(|a| !a.contains("<x/>")));
        assert_eq!(envs[0], ("HYPERGATE_NOTIFY_TITLE".to_string(), "<x/>".to_string()));
    }

    #[test]
    fn unknown_platforms_have_no_plan() {
        assert!(plan("haiku", "t", "b").is_none());
    }
}
