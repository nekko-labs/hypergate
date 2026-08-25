//! The manager window: the daemon's web UI in a native webview.
//!
//! This is the "desktop app" face of Hypergate. The window hosts the exact same
//! UI the daemon serves at `/` (one UI, two frames), so nothing is
//! reimplemented and the browser remains a first-class fallback. The webview is
//! the OS's own (WebView2 / WKWebView / WebKitGTK), so no browser engine ships
//! in the binary and the download stays small.
//!
//! Closing the window does not have one obvious meaning — Hypergate is a
//! resident agent, but it is also the thing running your servers — so the
//! window is hidden rather than destroyed and the *decision* is the user's
//! (see `CloseAction`). Hiding also keeps the webview alive, so reopening is
//! instant and the page keeps its scroll position and open panels.
//!
//! The page can talk back: {@link ManagerWindow::ask_close} calls into it, and
//! the answer arrives over wry's IPC channel as a `Wake::Close`.
//!
//! # The title bar is the page
//!
//! The window has no OS title bar. The page's own top bar — mark, wordmark,
//! version, theme, health — *is* the title bar, so the app gets one strip of
//! chrome instead of an OS one stacked above its own, and the window buttons
//! sit in the app's background rather than in a frame around it.
//!
//! That costs the shell what the frame used to give it for free: dragging,
//! minimising, maximising and closing all arrive from the page as IPC
//! messages, and the page has to be told which platform it is drawing for
//! (see {@link ManagerWindow::shell_init_script}). macOS is the exception —
//! its traffic lights stay native, floating over a transparent title bar, and
//! it draws no buttons of its own.

use tao::dpi::LogicalSize;
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder, WindowId};
use wry::{NewWindowFeatures, NewWindowResponse};

use crate::tray::{CloseDecision, Wake, WindowCommand};
use crate::{api, icon};

/// Whether a URL is one we're willing to hand to the OS.
///
/// `open` gives whatever it is to the same shell that launches programs, and
/// these strings come from a page — which, for a remote MCP server's sign-in
/// flow, is a page we did not write. Web schemes only, matched case-
/// insensitively because `HTTP://` is a valid way to write one.
fn is_web_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Hand a URL to the OS, for the browser to deal with.
fn open_external(url: &str) {
    if is_web_url(url) {
        let _ = open::that_detached(url);
    }
}

/// The link that asks another local app to connect itself to this gateway.
///
/// Built here rather than taken from the page, which is the whole point: the
/// page may name a *client* we know about, and the URL that reaches the OS is
/// then ours, carrying our own port and nothing else. `is_web_url` keeps every
/// other scheme out of `open_external` for exactly this reason, and widening it
/// would have let any page in the webview launch anything.
fn client_deep_link(client: &str) -> Option<String> {
    match client {
        "kotrain" => Some(format!("kotrain://hypergate/connect?port={}", crate::paths::port())),
        _ => None,
    }
}

/// The size the window opens at when the screen has room for it.
///
/// The manager is a two-column-ish dashboard — a server list whose rows carry a
/// state pill, a runtime chip, a tool count and five controls — and it reads
/// cramped before it reads wide, so the default errs on the generous side.
const PREFERRED: (f64, f64) = (1360.0, 900.0);
/// Below this the layout stops giving each panel a usable share of the height,
/// so the window refuses to be dragged smaller (it scrolls instead).
const MINIMUM: (f64, f64) = (600.0, 420.0);
/// How much of the monitor the default is allowed to take. A window that opens
/// exactly as tall as the screen has its title bar under the taskbar on
/// Windows and its bottom edge under the Dock on macOS, so leave a margin
/// rather than trusting a work-area query that every platform reports
/// differently.
const SCREEN_FRACTION: f64 = 0.9;

/// Height of the page's title bar, in CSS pixels.
///
/// The shell needs the number for two things: placing the macOS traffic lights
/// on the wordmark's line (once the title bar is transparent, where they sit is
/// ours to decide), and telling the page what it agreed to. Keep it in step
/// with `--titlebar-h` in `apps/web/src/styles.css`.
const TITLEBAR_HEIGHT: f64 = 52.0;

pub struct ManagerWindow {
    window: Window,
    /// Owned so it lives exactly as long as the window; dropped together.
    webview: wry::WebView,
}

impl ManagerWindow {
    /// Create the window and point its webview at the daemon's UI.
    ///
    /// Fails when the platform webview is missing (no WebView2 runtime, no
    /// webkit2gtk); the caller falls back to the browser, which serves the
    /// same UI, so the feature degrades instead of dying.
    pub fn open(target: &EventLoopWindowTarget<Wake>, proxy: EventLoopProxy<Wake>) -> Result<Self, String> {
        Self::open_with(target, proxy, None)
    }

    /// Create a manager window with the local startup status page.
    pub fn open_starting(
        target: &EventLoopWindowTarget<Wake>,
        proxy: EventLoopProxy<Wake>,
        html: String,
    ) -> Result<Self, String> {
        Self::open_with(target, proxy, Some(html))
    }

    fn open_with(
        target: &EventLoopWindowTarget<Wake>,
        proxy: EventLoopProxy<Wake>,
        html: Option<String>,
    ) -> Result<Self, String> {
        let mut builder = WindowBuilder::new()
            .with_title("Hypergate")
            .with_inner_size(Self::default_size(target))
            .with_min_inner_size(LogicalSize::new(MINIMUM.0, MINIMUM.1));
        builder = Self::without_titlebar(builder);
        // Windows and Linux take the icon per-window; macOS ignores it (the
        // Dock/switcher icon comes from the .app bundle instead).
        if let Ok(mark) = icon::window_icon() {
            builder = builder.with_window_icon(Some(mark));
        }
        let window = builder
            .build(target)
            .map_err(|e| format!("could not create the manager window: {e}"))?;

        let webview = match html {
            Some(html) => Self::attach_html(&window, proxy, html)?,
            None => Self::attach_webview(&window, proxy)?,
        };

        window.set_focus();
        Ok(Self { window, webview })
    }

    /// Replace the startup page with the daemon-backed manager URL.
    pub fn navigate(&self, url: &str) {
        let _ = self.webview.load_url(url);
    }

    /// Replace the current document with a local status or error page.
    pub fn show_html(&self, html: &str) {
        if let Ok(script) = serde_json::to_string(html) {
            let _ = self
                .webview
                .evaluate_script(&format!("document.open();document.write({script});document.close();"));
        }
    }

    /// Update the small status message on the local startup page without
    /// replacing the document and resetting the webview.
    pub fn update_startup_status(&self, seconds: u64) {
        let message = format!("Still waiting for the local daemon… {seconds}s elapsed.");
        if let Ok(text) = serde_json::to_string(&message) {
            let _ = self.webview.evaluate_script(&format!(
                "const e=document.getElementById('startup-message');if(e)e.textContent={text};"
            ));
        }
    }

    /// Take the OS title bar away so the page's own top bar can be it.
    ///
    /// macOS keeps its frame: the traffic lights are the only way to close a
    /// Mac window that Mac users trust, and the platform hands us exactly what
    /// we want — a transparent title bar over a full-size content view, with
    /// the buttons floating on top of the page and nothing else drawn.
    #[cfg(target_os = "macos")]
    fn without_titlebar(builder: WindowBuilder) -> WindowBuilder {
        use tao::dpi::LogicalPosition;
        use tao::platform::macos::WindowBuilderExtMacOS;
        builder
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true)
            // Centred on our strip: the buttons are 16px tall, so half the
            // difference puts them on the wordmark's line rather than above it.
            .with_traffic_light_inset(LogicalPosition::new(20.0, (TITLEBAR_HEIGHT - 16.0) / 2.0))
    }

    /// Windows and Linux have no equivalent, so the frame goes entirely and the
    /// page draws its own buttons. Both still resize from the window edges and
    /// still raise `CloseRequested` for Alt+F4.
    #[cfg(not(target_os = "macos"))]
    fn without_titlebar(builder: WindowBuilder) -> WindowBuilder {
        builder.with_decorations(false)
    }

    /// What the page needs to know before it renders a single pixel.
    ///
    /// The same bundle is served to a browser tab, where none of this applies,
    /// so the page keys off the *existence* of `__hypergateShell`: no object,
    /// no title bar of its own. `buttons` is what actually differs between
    /// platforms — on macOS the OS is still drawing them.
    fn shell_init_script() -> String {
        format!(
            "window.__hypergateShell = {{ platform: '{platform}', buttons: {buttons}, titleBarHeight: {height} }};",
            platform = if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(windows) {
                "windows"
            } else {
                "linux"
            },
            buttons = !cfg!(target_os = "macos"),
            height = TITLEBAR_HEIGHT,
        )
    }

    /// The default size, shrunk to fit when the screen is smaller than we want.
    ///
    /// `with_inner_size` is a request, not a constraint: nothing clamps it to
    /// the display, so a fixed default that suits a desktop monitor opens with
    /// its bottom edge off a laptop screen.
    fn default_size(target: &EventLoopWindowTarget<Wake>) -> LogicalSize<f64> {
        let (mut width, mut height) = PREFERRED;
        if let Some(monitor) = target.primary_monitor() {
            let screen: LogicalSize<f64> = monitor.size().to_logical(monitor.scale_factor());
            width = width.min(screen.width * SCREEN_FRACTION).max(MINIMUM.0);
            height = height.min(screen.height * SCREEN_FRACTION).max(MINIMUM.1);
        }
        LogicalSize::new(width, height)
    }

    /// A new window belongs in the user's browser.
    ///
    /// This frame has no tabs, no address bar and no back button, so a popup
    /// inside it would be a dead end — and left unhandled it isn't even that.
    /// WebView2 raises `NewWindowRequested` and, with nobody listening, drops
    /// the request on the floor: every `target="_blank"` link and the OAuth
    /// sign-in popup did nothing at all in the app while working in a browser
    /// tab. Hand them to the real browser instead, where the user is already
    /// signed in to GitHub and can see what they are authorizing.
    fn open_externally(url: String, _features: NewWindowFeatures) -> NewWindowResponse {
        open_external(&url);
        NewWindowResponse::Deny
    }

    /// The page's side of the conversation. Only ever messages we defined:
    /// anything else on this channel is ignored rather than acted on.
    fn ipc_handler(proxy: EventLoopProxy<Wake>) -> impl Fn(wry::http::Request<String>) + 'static {
        move |req| {
            let body = req.body().as_str();
            // A window the page opens itself, rather than one the user clicked
            // a link to. `window.open` reaches `open_externally` above on some
            // webviews and is quietly swallowed on others (a popup blocked for
            // want of a user gesture never becomes a new-window request at
            // all), so the page asks us directly and the answer is the same.
            if let Some(url) = body.strip_prefix("open:") {
                open_external(url);
                return;
            }
            // "Connect Kotrain": the page names a client, we build and launch
            // that client's own URL. An unknown name is ignored, so the list of
            // apps this can start is the one written above and no other.
            if let Some(client) = body.strip_prefix("connect:") {
                if let Some(link) = client_deep_link(client) {
                    let _ = open::that_detached(link);
                }
                return;
            }
            let event = match body {
                "close:asking" => Wake::CloseAsked,
                "close:tray" => Wake::Close(CloseDecision::Tray),
                "close:quit" => Wake::Close(CloseDecision::Quit),
                "close:cancel" => Wake::Close(CloseDecision::Cancel),
                // The title bar is the page's, so these are the frame's old job
                // coming back to us from the buttons that replaced it. They go
                // round through the event loop rather than acting here because
                // the window lives there, not in this closure.
                "window:minimize" => Wake::Window(WindowCommand::Minimize),
                "window:maximize" => Wake::Window(WindowCommand::ToggleMaximize),
                "window:drag" => Wake::Window(WindowCommand::Drag),
                // Deliberately the same event the frame's X used to raise, so
                // the close question and the remembered answer behave
                // identically however the window was closed.
                "window:close" => Wake::Window(WindowCommand::Close),
                "starting:retry" => Wake::RetryStartup,
                "starting:browser" => Wake::OpenStartupBrowser,
                _ => return,
            };
            let _ = proxy.send_event(event);
        }
    }

    /// Windows and macOS attach straight to the window handle.
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    fn attach_webview(window: &Window, proxy: EventLoopProxy<Wake>) -> Result<wry::WebView, String> {
        wry::WebViewBuilder::new()
            .with_url(api::ui_url())
            .with_initialization_script(Self::shell_init_script())
            .with_ipc_handler(Self::ipc_handler(proxy))
            .with_new_window_req_handler(Self::open_externally)
            .build(window)
            .map_err(|e| format!("could not create the webview: {e}"))
    }

    #[cfg(not(all(unix, not(target_os = "macos"))))]
    /// Attach a webview whose first document is supplied by the shell.
    fn attach_html(window: &Window, proxy: EventLoopProxy<Wake>, html: String) -> Result<wry::WebView, String> {
        wry::WebViewBuilder::new()
            .with_html(&html)
            .with_initialization_script(Self::shell_init_script())
            .with_ipc_handler(Self::ipc_handler(proxy))
            .with_new_window_req_handler(Self::open_externally)
            .build(window)
            .map_err(|e| format!("could not create the webview: {e}"))
    }

    /// Linux: tao windows are GTK, so the webview goes into the window's
    /// default vertical box rather than onto the raw handle.
    #[cfg(all(unix, not(target_os = "macos")))]
    fn attach_webview(window: &Window, proxy: EventLoopProxy<Wake>) -> Result<wry::WebView, String> {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .ok_or("the manager window has no GTK container to hold a webview")?;
        wry::WebViewBuilder::new()
            .with_url(api::ui_url())
            .with_initialization_script(Self::shell_init_script())
            .with_ipc_handler(Self::ipc_handler(proxy))
            .with_new_window_req_handler(Self::open_externally)
            .build_gtk(vbox)
            .map_err(|e| format!("could not create the webview: {e}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    /// Attach a GTK webview whose first document is supplied by the shell.
    fn attach_html(window: &Window, proxy: EventLoopProxy<Wake>, html: String) -> Result<wry::WebView, String> {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .ok_or("the manager window has no GTK container to hold a webview")?;
        wry::WebViewBuilder::new()
            .with_html(&html)
            .with_initialization_script(Self::shell_init_script())
            .with_ipc_handler(Self::ipc_handler(proxy))
            .with_new_window_req_handler(Self::open_externally)
            .build_gtk(vbox)
            .map_err(|e| format!("could not create the webview: {e}"))
    }

    pub fn id(&self) -> WindowId {
        self.window.id()
    }

    /// Bring an already-open window back to the front (and back into existence,
    /// when it was hidden by a close).
    ///
    /// Un-minimize first: a miniaturized window ignores `makeKeyAndOrderFront:`
    /// and tao's `set_focus` refuses to touch one, so without this every
    /// "bring it back" path (the tray's Open manager, the tray double-click,
    /// the second-launch handoff, the Dock click) was a silent no-op on a
    /// window the user had minimized.
    pub fn focus(&self) {
        self.window.set_minimized(false);
        self.window.set_visible(true);
        self.window.set_focus();
    }

    /// Get out of the way without going away: the gateway and every managed
    /// server keep running, and the tray icon is how you come back.
    pub fn hide(&self) {
        self.window.set_visible(false);
    }

    /// Everything the frame used to do, now that the page's buttons ask for it.
    pub fn command(&self, cmd: WindowCommand) {
        match cmd {
            WindowCommand::Minimize => self.window.set_minimized(true),
            WindowCommand::ToggleMaximize => {
                self.window.set_maximized(!self.window.is_maximized());
                self.notify_window_state();
            }
            // Pointer-driven, so failure just means the gesture ended early
            // (the button was already up, the compositor said no); there is
            // nothing to report and nothing to retry.
            WindowCommand::Drag => {
                let _ = self.window.drag_window();
            }
            // Handled by the caller, which owns the close decision.
            WindowCommand::Close => {}
        }
    }

    /// Tell the page whether the window is maximised, so its middle button can
    /// show "restore" instead.
    ///
    /// Pushed rather than polled, and pushed on every resize: snapping to half
    /// the screen and double-clicking the title bar both change the answer
    /// without going through our button.
    pub fn notify_window_state(&self) {
        let maximized = self.window.is_maximized();
        let _ = self.webview.evaluate_script(&format!(
            "window.__hypergateOnWindowState && window.__hypergateOnWindowState({{ maximized: {maximized} }})"
        ));
    }

    /// Ask the page what closing should do. The answer comes back over IPC as a
    /// `Wake::Close`; the caller sets a deadline, because a page that failed to
    /// load cannot answer and the window must still close.
    pub fn ask_close(&self) {
        let _ = self
            .webview
            .evaluate_script("window.__hypergateAskClose && window.__hypergateAskClose()");
    }
}

#[cfg(test)]
mod tests {
    use super::{client_deep_link, is_web_url};

    #[test]
    fn opens_web_urls() {
        assert!(is_web_url("https://github.com/login/oauth/authorize?client_id=x"));
        assert!(is_web_url("http://localhost:7777/oauth/callback"));
        // A scheme is case-insensitive, and a page is free to write it either way.
        assert!(is_web_url("HTTPS://example.com"));
    }

    #[test]
    fn refuses_everything_else() {
        // The URL comes from a page, so the schemes that launch programs or
        // read the disk must not survive the trip to the OS.
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "ms-settings:windowsupdate",
            "vscode://file/etc/passwd",
            "",
            // Not a scheme — a path that merely starts with the right letters.
            "https-not-really/x",
        ] {
            assert!(!is_web_url(url), "should have refused {url}");
        }
    }

    #[test]
    fn builds_a_clients_own_link() {
        let link = client_deep_link("kotrain").expect("kotrain is a known client");
        assert!(link.starts_with("kotrain://hypergate/connect?port="));
        // The port is ours, and a credential never rides along.
        assert!(link.contains(&crate::paths::port().to_string()));
        assert!(!link.contains("token"));
    }

    #[test]
    fn refuses_clients_it_does_not_know() {
        // The page names a client, not a URL: an unknown name has to be a
        // no-op, or naming one would be the same as launching anything.
        for client in ["", "explorer", "kotrain://x", "file:///c:/windows"] {
            assert!(client_deep_link(client).is_none(), "should have refused {client}");
        }
    }
}
