//! The tray agent: a system-tray icon with a menu, supervising the daemon.
//!
//! Interaction is **menu-only on every platform**, deliberately. Linux's
//! StatusNotifierItem delivers no click events at all, so a click-to-open
//! gesture would silently not exist there; making the menu the single surface
//! keeps behaviour identical across Windows, macOS and Linux.
//!
//! The UI opens in the user's default browser rather than a bundled webview:
//! developers already have a browser, and it beats WebKitGTK on Linux.

use std::sync::mpsc;
use std::time::Duration;

use muda::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{TrayIcon, TrayIconBuilder};

use crate::{api, autostart, daemon, icon, secrets};

/// Stable menu ids. Using explicit ids (rather than comparing generated ones)
/// keeps the click handler readable and survives menu reordering.
mod id {
    pub const OPEN: &str = "open";
    pub const START_ALL: &str = "start-all";
    pub const STOP_ALL: &str = "stop-all";
    pub const RESTART_DAEMON: &str = "restart-daemon";
    pub const AUTOSTART: &str = "autostart";
    pub const QUIT: &str = "quit";
}

/// Woken into the tao loop so menu clicks are handled immediately rather than
/// on a polling tick. "Fast and fluid" means no perceptible menu latency.
enum Wake {
    Menu(MenuEvent),
    /// A refreshed status line for the menu header.
    Status(String),
}

/// Everything the running tray owns.
struct Tray {
    _icon: TrayIcon,
    status: MenuItem,
    autostart: CheckMenuItem,
    /// The daemon we launched, if we launched it. `None` when we attached to an
    /// already-running daemon, in which case quitting the tray leaves it alone.
    child: Option<std::process::Child>,
}

/// Build the menu and the tray icon. Called once the event loop is alive, which
/// macOS requires (the status item needs a running NSApplication).
fn build(child: Option<std::process::Child>) -> Result<Tray, String> {
    let menu = Menu::new();

    // A disabled header line showing live daemon state, refreshed on a timer.
    let status = MenuItem::new("Checking daemon…", false, None);
    let open = MenuItem::with_id(id::OPEN, "Open manager", true, None);
    let start_all = MenuItem::with_id(id::START_ALL, "Start all servers", true, None);
    let stop_all = MenuItem::with_id(id::STOP_ALL, "Stop all servers", true, None);
    let restart = MenuItem::with_id(id::RESTART_DAEMON, "Restart daemon", true, None);
    let start_at_login = CheckMenuItem::with_id(
        id::AUTOSTART,
        "Start at login",
        autostart::is_supported(),
        autostart::is_enabled(),
        None,
    );
    let quit = MenuItem::with_id(id::QUIT, "Quit Hypergate", true, None);

    menu.append_items(&[
        &status,
        &PredefinedMenuItem::separator(),
        &open,
        &PredefinedMenuItem::separator(),
        &start_all,
        &stop_all,
        &restart,
        &PredefinedMenuItem::separator(),
        &start_at_login,
        &PredefinedMenuItem::separator(),
        &quit,
    ])
    .map_err(|e| format!("could not build the tray menu: {e}"))?;

    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_icon(icon::tray_icon()?)
        .with_icon_as_template(icon::is_template())
        .with_tooltip("Hypergate")
        // Windows convention is the menu on right-click; showing it on left-click
        // too means one predictable gesture everywhere it is supported at all.
        .with_menu_on_left_click(true)
        .build()
        .map_err(|e| format!("could not create the tray icon: {e}"))?;

    Ok(Tray { _icon: tray, status, autostart: start_at_login, child })
}

/// One line of live daemon state for the menu header.
fn status_line() -> String {
    match api::health() {
        Ok(h) => {
            let calls = api::analytics().map(|a| a.total_calls).unwrap_or(0);
            format!("Running · {} server(s) · {} call(s)", h.servers, calls)
        }
        Err(_) => "Daemon not responding".to_string(),
    }
}

/// Run the tray agent. Blocks until the user quits.
pub fn run() -> Result<(), String> {
    // Only one tray at a time, or the user gets duplicate icons that fight over
    // the same daemon. The lock is a bound loopback socket, which the OS releases
    // automatically however this process dies (no stale lock file to clean up).
    let _lock = match single_instance() {
        Some(l) => l,
        None => {
            // Another tray owns the icon; the useful thing is to surface the UI.
            let _ = open::that_detached(api::ui_url());
            return Ok(());
        }
    };

    // Make the keychain authoritative before the daemon boots, so it inherits
    // the token via HYPERGATE_TOKEN and never writes a plaintext copy.
    let adopted = secrets::adopt_gateway_token();
    if adopted == secrets::Adopted::MigratedFromFile {
        eprintln!("[hypergate] moved the gateway token into the OS keychain");
    }

    // Attach to a running daemon if there is one; otherwise start our own.
    let child = if api::is_up() {
        eprintln!("[hypergate] attached to the daemon already running on this port");
        None
    } else {
        let c = daemon::spawn_child()?;
        if !daemon::wait_until_up(Duration::from_secs(20)) {
            eprintln!("[hypergate] warning: the daemon did not answer /health within 20s");
        }
        Some(c)
    };

    // `mut` only matters on macOS, where set_activation_policy takes &mut self.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut event_loop = EventLoopBuilder::<Wake>::with_user_event().build();

    // macOS: a menu-bar-only agent, with no Dock icon and no app switcher entry.
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        event_loop.set_dock_visibility(false);
    }

    // Forward muda's menu events into the loop so clicks are acted on at once.
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        let _ = menu_proxy.send_event(Wake::Menu(e));
    }));

    // Refresh the header line off-thread; the HTTP calls must never block the UI.
    let status_proxy = event_loop.create_proxy();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || loop {
        let _ = status_proxy.send_event(Wake::Status(status_line()));
        if stop_rx.recv_timeout(Duration::from_secs(4)).is_ok() {
            return; // shutting down
        }
    });

    let mut tray: Option<Tray> = None;
    let mut pending_child = child;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            // The tray must be created after the event loop is running (macOS).
            Event::NewEvents(tao::event::StartCause::Init) => {
                match build(pending_child.take()) {
                    Ok(t) => {
                        // A successful build means the OS accepted the icon
                        // (Shell_NotifyIcon / NSStatusItem / SNI registration),
                        // so this line is the confirmation that the tray is live.
                        eprintln!("[hypergate] tray icon registered · menu ready");
                        tray = Some(t);
                    }
                    Err(e) => {
                        eprintln!("[hypergate] {e}");
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }

            Event::UserEvent(Wake::Status(line)) => {
                if let Some(t) = &tray {
                    t.status.set_text(&line);
                    // Reconcile the checkbox with the real OS state, so a change
                    // made outside the app (or in the web UI) shows up here.
                    t.autostart.set_checked(autostart::is_enabled());
                }
            }

            Event::UserEvent(Wake::Menu(ev)) => {
                let clicked = ev.id.as_ref();
                match clicked {
                    id::OPEN => {
                        let _ = open::that_detached(api::ui_url());
                    }
                    id::START_ALL => act_on_all(true),
                    id::STOP_ALL => act_on_all(false),
                    id::RESTART_DAEMON => {
                        if let Some(t) = &mut tray {
                            restart_daemon(t);
                        }
                    }
                    id::AUTOSTART => {
                        if let Some(t) = &tray {
                            // muda has already toggled the visual state; apply it,
                            // then re-read the OS so a failure cannot leave the
                            // checkbox lying about reality.
                            let want = t.autostart.is_checked();
                            let result = if want { autostart::enable() } else { autostart::disable() };
                            if let Err(e) = result {
                                eprintln!("[hypergate] could not change the login item: {e}");
                            }
                            t.autostart.set_checked(autostart::is_enabled());
                        }
                    }
                    id::QUIT => {
                        let _ = stop_tx.send(());
                        if let Some(t) = &mut tray {
                            // Only reap the daemon if this tray started it.
                            if let Some(child) = &mut t.child {
                                let _ = child.kill();
                                let _ = child.wait();
                            }
                        }
                        *control_flow = ControlFlow::Exit;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    });
}

/// Start or stop every managed server. Runs off-thread: a dozen servers means a
/// dozen HTTP round trips, and the menu must not freeze while they happen.
fn act_on_all(start: bool) {
    std::thread::spawn(move || match api::servers() {
        Ok(servers) => {
            for s in servers {
                let r = if start { api::start_server(&s.id) } else { api::stop_server(&s.id) };
                if let Err(e) = r {
                    eprintln!("[hypergate] {} {} failed: {e}", if start { "start" } else { "stop" }, s.id);
                }
            }
        }
        Err(e) => eprintln!("[hypergate] could not list servers: {e}"),
    });
}

/// Restart the daemon we own, replacing the child handle.
fn restart_daemon(tray: &mut Tray) {
    if let Some(child) = &mut tray.child {
        let _ = child.kill();
        let _ = child.wait();
    } else if daemon::stop().is_err() {
        eprintln!("[hypergate] this tray did not start the daemon, so it cannot restart it");
        return;
    }
    match daemon::spawn_child() {
        Ok(c) => {
            tray.child = Some(c);
            tray.status.set_text("Restarting daemon…");
        }
        Err(e) => eprintln!("[hypergate] could not restart the daemon: {e}"),
    }
}

/// Bind a loopback port as a single-instance lock. Cross-platform, and released
/// by the OS on exit however abrupt, unlike a pid or lock file.
fn single_instance() -> Option<std::net::TcpListener> {
    // One above the daemon's port, so a custom PORT keeps them paired.
    let port = crate::paths::port().saturating_add(1);
    std::net::TcpListener::bind(("127.0.0.1", port)).ok()
}
