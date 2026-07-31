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

use tao::dpi::LogicalSize;
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder, WindowId};

use crate::tray::{CloseDecision, Wake};
use crate::{api, icon};

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
        let mut builder = WindowBuilder::new()
            .with_title("Hypergate")
            .with_inner_size(LogicalSize::new(1200.0, 820.0))
            .with_min_inner_size(LogicalSize::new(600.0, 420.0));
        // Windows and Linux take the icon per-window; macOS ignores it (the
        // Dock/switcher icon comes from the .app bundle instead).
        if let Ok(mark) = icon::window_icon() {
            builder = builder.with_window_icon(Some(mark));
        }
        let window = builder
            .build(target)
            .map_err(|e| format!("could not create the manager window: {e}"))?;

        let webview = Self::attach_webview(&window, proxy)?;

        window.set_focus();
        Ok(Self { window, webview })
    }

    /// The page's side of the close conversation. Only ever messages we defined:
    /// anything else on this channel is ignored rather than acted on.
    fn ipc_handler(proxy: EventLoopProxy<Wake>) -> impl Fn(wry::http::Request<String>) + 'static {
        move |req| {
            let event = match req.body().as_str() {
                "close:asking" => Wake::CloseAsked,
                "close:tray" => Wake::Close(CloseDecision::Tray),
                "close:quit" => Wake::Close(CloseDecision::Quit),
                "close:cancel" => Wake::Close(CloseDecision::Cancel),
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
            .with_ipc_handler(Self::ipc_handler(proxy))
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
            .with_ipc_handler(Self::ipc_handler(proxy))
            .build_gtk(vbox)
            .map_err(|e| format!("could not create the webview: {e}"))
    }

    pub fn id(&self) -> WindowId {
        self.window.id()
    }

    /// Bring an already-open window back to the front (and back into existence,
    /// when it was hidden by a close).
    pub fn focus(&self) {
        self.window.set_visible(true);
        self.window.set_focus();
    }

    /// Get out of the way without going away: the gateway and every managed
    /// server keep running, and the tray icon is how you come back.
    pub fn hide(&self) {
        self.window.set_visible(false);
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
