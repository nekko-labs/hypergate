//! The tray agent: a system-tray icon with a menu, supervising the daemon,
//! plus the manager window (`window.rs`) when the user wants a real app.
//!
//! The menu is the surface that exists everywhere: Linux's StatusNotifierItem
//! delivers no click events at all, so any click gesture has to be an addition
//! to it, never a replacement. On Windows, where clicks *are* delivered, we
//! follow the platform convention on top of that — right-click for the menu,
//! **double-click to open the app** — because that is what a tray icon means
//! there. macOS keeps the single-click menu its menu bar extras all use.
//!
//! "Open manager" prefers the native manager window and falls back to the
//! default browser when the platform webview is unavailable; both frames show
//! the same UI the daemon serves, so nothing is lost either way.

use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;
use std::time::Duration;

use muda::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tray_icon::{TrayIcon, TrayIconBuilder};

use crate::api::CloseAction;
use crate::window::ManagerWindow;
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

/// Close the console window Windows created for us, when it is ours alone.
///
/// `hypergate` is one binary doing both CLI and tray work, so it must be a
/// console subsystem app. Launched from Explorer (a Start Menu shortcut, say)
/// that means Windows opens a console window and leaves it sitting behind the
/// tray icon for as long as the agent runs, which looks broken.
///
/// `GetConsoleProcessList` distinguishes the two cases: a console created just
/// for us has exactly one process attached, while a console we were launched
/// *into* from a terminal has at least two (the shell and us). Only the former
/// gets closed, so running `hypergate tray` from a terminal still prints the
/// daemon's output the way it always has.
#[cfg(windows)]
fn hide_own_console() {
    use windows::Win32::System::Console::{FreeConsole, GetConsoleProcessList};

    unsafe {
        let mut pids = [0u32; 2];
        if GetConsoleProcessList(&mut pids) == 1 {
            let _ = FreeConsole();
        }
    }
}

#[cfg(not(windows))]
fn hide_own_console() {}

/// What closing the manager window should actually do, once decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseDecision {
    /// Hide the window; the gateway and every managed server keep running.
    Tray,
    /// Take the whole thing down, daemon included.
    Quit,
    /// Never mind — leave the window open.
    Cancel,
}

/// Woken into the tao loop so menu clicks are handled immediately rather than
/// on a polling tick. "Fast and fluid" means no perceptible menu latency.
pub(crate) enum Wake {
    Menu(MenuEvent),
    /// A refreshed status line for the menu header, the real OS autostart
    /// state, and the current close-button preference. All three are computed
    /// on the polling thread: the UI thread only ever applies them, so nothing
    /// that can block (HTTP, registry, launchctl) runs where it could freeze an
    /// open menu — or stall a window close.
    Status(String, bool, CloseAction),
    /// Show the manager window (from the menu, from a tray double-click, or
    /// from a second `hypergate app` launch handing off through the
    /// single-instance socket).
    OpenWindow,
    /// Quit, asked for over the single-instance socket. Used by `hypergate
    /// update --apply`, which has to get the tray out of the way before the
    /// files it is running from can be replaced.
    Quit,
    /// The close question has an answer, from the window's own prompt.
    Close(CloseDecision),
    /// The page confirmed the prompt is on screen. Stops the deadline below:
    /// someone is reading it, and yanking the window away mid-read would be
    /// exactly the rudeness the prompt exists to avoid.
    CloseAsked,
    /// Nobody answered and nobody said the prompt appeared, so the page can't
    /// have loaded. Close anyway — a window that refuses to close is worse than
    /// a question that went unasked.
    CloseDeadline,
    /// The manager window has no OS frame, so its title bar is the page's own
    /// top bar and these arrive from the buttons drawn there.
    Window(WindowCommand),
}

/// What the window frame used to offer, asked for by the page instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowCommand {
    Minimize,
    ToggleMaximize,
    /// Start an OS window-move gesture; the pointer is already down.
    Drag,
    /// Exactly what the frame's X used to mean, close preference and all.
    Close,
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
        .with_tooltip(if cfg!(windows) {
            "Hypergate — double-click to open"
        } else {
            "Hypergate"
        })
        // Windows: the menu belongs on right-click, which frees the left button
        // for the gesture users already expect from a tray icon — double-click
        // opens the app. Everywhere else the menu stays on left-click: macOS
        // menu bar extras work that way, and Linux delivers no clicks for a
        // double-click gesture to be built out of.
        .with_menu_on_left_click(!cfg!(windows))
        .build()
        .map_err(|e| format!("could not create the tray icon: {e}"))?;

    Ok(Tray {
        _icon: tray,
        status,
        autostart: start_at_login,
        child,
    })
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

/// Run the tray agent, and the manager window when `with_window` asks for one
/// up front (`hypergate app`). Blocks until the user quits.
pub fn run(with_window: bool) -> Result<(), String> {
    hide_own_console();

    // Only one tray at a time, or the user gets duplicate icons that fight over
    // the same daemon. The lock is a bound loopback socket, which the OS releases
    // automatically however this process dies (no stale lock file to clean up).
    let lock = match single_instance() {
        Some(l) => l,
        None => {
            // Another instance owns the icon. A second `app` launch means "show
            // me the app", so ask the owner to surface its manager window
            // (browser fallback if it won't answer). A second `tray` launch is
            // a login item finding the agent already running: do nothing.
            if with_window && !ask_running_instance_to_open() {
                let _ = open::that_detached(api::ui_url());
            }
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

    // Double-click the icon to open the app. Windows-only in the crate (the
    // event simply is not synthesised elsewhere), which matches where the
    // gesture is a convention in the first place.
    let click_proxy = event_loop.create_proxy();
    tray_icon::TrayIconEvent::set_event_handler(Some(move |e: tray_icon::TrayIconEvent| {
        if let tray_icon::TrayIconEvent::DoubleClick {
            button: tray_icon::MouseButton::Left,
            ..
        } = e
        {
            let _ = click_proxy.send_event(Wake::OpenWindow);
        }
    }));

    // The single-instance lock doubles as a handoff channel. Two verbs, both
    // loopback-only and both things a local process could already do for itself:
    // `open` surfaces the manager UI, and `quit` shuts the agent down, which is
    // how `hypergate update --apply` clears the way before replacing our files.
    let open_proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        for stream in lock.incoming().flatten() {
            let mut line = String::new();
            let mut reader = BufReader::new(stream);
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            match line.trim() {
                "open" => {
                    let _ = open_proxy.send_event(Wake::OpenWindow);
                }
                "quit" => {
                    let _ = open_proxy.send_event(Wake::Quit);
                }
                _ => {}
            }
        }
    });

    // Refresh the header line off-thread; the HTTP calls must never block the UI.
    // The autostart checkbox state and the close-button preference ride along,
    // so a change made outside the app (or in the web UI) shows up here without
    // the UI thread ever doing a read that could block — which matters most at
    // the moment the user clicks the window's close button.
    let status_proxy = event_loop.create_proxy();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        loop {
            let _ = status_proxy.send_event(Wake::Status(
                status_line(),
                autostart::is_enabled(),
                api::close_action(),
            ));
            if stop_rx.recv_timeout(Duration::from_secs(4)).is_ok() {
                return; // shutting down
            }
        }
    });

    let mut tray: Option<Tray> = None;
    let mut window: Option<ManagerWindow> = None;
    let mut pending_child = child;
    // Nothing has been read from the daemon yet, so ask rather than assume.
    let mut close_action = CloseAction::Ask;
    // A close question is outstanding; a second close must not re-ask.
    let mut awaiting_close = false;
    // …and the page has confirmed it is actually showing that question.
    let mut prompt_shown = false;
    // Handed to the manager window so its page can answer that question.
    let window_proxy = event_loop.create_proxy();

    event_loop.run(move |event, target, control_flow| {
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
                // `hypergate app` always means "show me the app". A login-time
                // `hypergate tray` defers to the Start minimized preference,
                // which is the only thing that setting was ever supposed to do.
                if with_window || !api::start_minimized() {
                    open_manager(&mut window, target, &window_proxy);
                }
            }

            Event::UserEvent(Wake::OpenWindow) => {
                open_manager(&mut window, target, &window_proxy);
            }

            Event::UserEvent(Wake::Quit) => {
                quit(&mut tray, &stop_tx, control_flow, false);
            }

            // Alt+F4 and the macOS traffic light still come through the frame;
            // the button the page draws sends `Wake::Window(Close)` directly.
            // Both land in the same arm below, so a close means the same thing
            // however it was asked for.
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } => {
                if window.as_ref().is_some_and(|w| w.id() == window_id) {
                    let _ = window_proxy.send_event(Wake::Window(WindowCommand::Close));
                }
            }

            // Snapping, double-clicking the title bar and dragging an edge all
            // change whether the page's middle button should say "restore".
            Event::WindowEvent {
                event: WindowEvent::Resized(_),
                window_id,
                ..
            } => {
                if let Some(w) = &window
                    && w.id() == window_id
                {
                    w.notify_window_state();
                }
            }

            // Closing the manager is a real choice, not a foregone conclusion:
            // Hypergate is a resident agent, but it is also what is running the
            // user's servers. Whichever way it goes the window is *hidden*, not
            // destroyed, so reopening is instant and the page keeps its state.
            Event::UserEvent(Wake::Window(WindowCommand::Close)) => {
                match close_action {
                    CloseAction::Tray => {
                        if let Some(w) = &window {
                            w.hide();
                        }
                    }
                    CloseAction::Quit => quit(&mut tray, &stop_tx, control_flow, true),
                    CloseAction::Ask => {
                        if awaiting_close {
                            // The prompt is already up and the user clicked
                            // the X again — take that as "yes, go away".
                            if let Some(w) = &window {
                                w.hide();
                            }
                            awaiting_close = false;
                        } else if let Some(w) = &window {
                            awaiting_close = true;
                            prompt_shown = false;
                            w.ask_close();
                            // A page that failed to load cannot answer, and
                            // a window that will not close is worse than a
                            // missed question. Cancelled the moment the page
                            // says the prompt is up, so a user reading it is
                            // never interrupted.
                            let deadline = window_proxy.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_secs(3));
                                let _ = deadline.send_event(Wake::CloseDeadline);
                            });
                        }
                    }
                }
            }

            // Minimise, maximise and drag: no decision to make, just do it.
            Event::UserEvent(Wake::Window(cmd)) => {
                if let Some(w) = &window {
                    w.command(cmd);
                }
            }

            Event::UserEvent(Wake::CloseAsked) => {
                prompt_shown = true;
            }

            Event::UserEvent(Wake::CloseDeadline) => {
                // Only when the prompt never made it on screen. Hiding is the
                // reversible outcome, so that is the one we default to.
                if awaiting_close && !prompt_shown {
                    awaiting_close = false;
                    eprintln!("[hypergate] the manager page did not answer the close prompt; hiding to the tray");
                    if let Some(w) = &window {
                        w.hide();
                    }
                }
            }

            Event::UserEvent(Wake::Close(decision)) => {
                if awaiting_close {
                    awaiting_close = false;
                    match decision {
                        CloseDecision::Tray => {
                            if let Some(w) = &window {
                                w.hide();
                            }
                        }
                        CloseDecision::Quit => quit(&mut tray, &stop_tx, control_flow, true),
                        CloseDecision::Cancel => {}
                    }
                }
            }

            Event::UserEvent(Wake::Status(line, autostart_on, action)) => {
                close_action = action;
                if let Some(t) = &tray {
                    t.status.set_text(&line);
                    // Reconcile the checkbox with the real OS state (read on the
                    // polling thread), so an outside change shows up here.
                    t.autostart.set_checked(autostart_on);
                }
            }

            Event::UserEvent(Wake::Menu(ev)) => {
                let clicked = ev.id.as_ref();
                match clicked {
                    id::OPEN => {
                        open_manager(&mut window, target, &window_proxy);
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
                            let result = if want {
                                autostart::enable()
                            } else {
                                autostart::disable()
                            };
                            if let Err(e) = result {
                                eprintln!("[hypergate] could not change the login item: {e}");
                            }
                            t.autostart.set_checked(autostart::is_enabled());
                        }
                    }
                    // The menu's Quit leaves a daemon this tray didn't start
                    // alone — it isn't ours to stop. The close button's "quit
                    // and stop the server" is an explicit instruction, so that
                    // one does stop it.
                    id::QUIT => quit(&mut tray, &stop_tx, control_flow, false),
                    _ => {}
                }
            }
            _ => {}
        }
    });
}

/// Shut the agent down: stop the status poller, reap the daemon if this tray
/// started it, and leave the event loop. Reached from the Quit menu item and
/// from a `quit` on the single-instance socket, which must behave identically.
///
/// `stop_daemon` extends that to a daemon we merely attached to. It is off for
/// the menu's Quit — a daemon someone else started is not ours to kill — and on
/// for the close button's "quit and stop the server", where the user asked for
/// exactly that and would not accept a gateway still serving afterwards.
fn quit(tray: &mut Option<Tray>, stop_tx: &mpsc::Sender<()>, control_flow: &mut ControlFlow, stop_daemon: bool) {
    let _ = stop_tx.send(());
    let mut ours = false;
    if let Some(t) = tray
        && let Some(child) = &mut t.child
    {
        let _ = child.kill();
        let _ = child.wait();
        ours = true;
    }
    // Not our child: the pid file if some shell recorded one, else the daemon's
    // own shutdown route (which our master token can call).
    if stop_daemon
        && !ours
        && !daemon::stop().unwrap_or(false)
        && let Err(e) = api::shutdown()
    {
        eprintln!("[hypergate] could not stop the daemon on quit: {e}");
    }
    *control_flow = ControlFlow::Exit;
}

/// Start or stop every managed server. Runs off-thread: a dozen servers means a
/// dozen HTTP round trips, and the menu must not freeze while they happen.
fn act_on_all(start: bool) {
    std::thread::spawn(move || match api::servers() {
        Ok(servers) => {
            for s in servers {
                let r = if start {
                    api::start_server(&s.id)
                } else {
                    api::stop_server(&s.id)
                };
                if let Err(e) = r {
                    eprintln!(
                        "[hypergate] {} {} failed: {e}",
                        if start { "start" } else { "stop" },
                        s.id
                    );
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

/// Show the manager window, creating it if it isn't open and un-hiding it if a
/// close put it away. When the platform webview can't be created (no WebView2
/// runtime, no webkit2gtk), fall back to the browser: same UI, different frame.
fn open_manager(
    window: &mut Option<ManagerWindow>,
    target: &tao::event_loop::EventLoopWindowTarget<Wake>,
    proxy: &EventLoopProxy<Wake>,
) {
    if let Some(w) = window.as_ref() {
        w.focus();
        return;
    }
    match ManagerWindow::open(target, proxy.clone()) {
        Ok(w) => *window = Some(w),
        Err(e) => {
            eprintln!("[hypergate] {e}; opening the manager in the browser instead");
            let _ = open::that_detached(api::ui_url());
        }
    }
}

/// Bind a loopback port as a single-instance lock. Cross-platform, and released
/// by the OS on exit however abrupt, unlike a pid or lock file.
fn single_instance() -> Option<std::net::TcpListener> {
    // One above the daemon's port, so a custom PORT keeps them paired.
    let port = crate::paths::port().saturating_add(1);
    std::net::TcpListener::bind(("127.0.0.1", port)).ok()
}

/// Ask the instance holding the lock to show its manager window. True when the
/// message was delivered.
fn ask_running_instance_to_open() -> bool {
    let port = crate::paths::port().saturating_add(1);
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    ) else {
        return false;
    };
    stream.write_all(b"open\n").is_ok()
}
