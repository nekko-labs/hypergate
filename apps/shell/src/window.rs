//! The manager window: the daemon's web UI in a native webview.
//!
//! This is the "desktop app" face of Hypergate. The window hosts the exact same
//! UI the daemon serves at `/` (one UI, two frames), so nothing is
//! reimplemented and the browser remains a first-class fallback. The webview is
//! the OS's own (WebView2 / WKWebView / WebKitGTK), so no browser engine ships
//! in the binary and the download stays small.
//!
//! Closing the window never quits the app: Hypergate is a resident agent, and
//! the tray stays. Quit lives in the tray menu, deliberately.

use tao::dpi::LogicalSize;
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder, WindowId};

use crate::{api, icon};

pub struct ManagerWindow {
    window: Window,
    /// Owned so it lives exactly as long as the window; dropped together.
    _webview: wry::WebView,
}

impl ManagerWindow {
    /// Create the window and point its webview at the daemon's UI.
    ///
    /// Fails when the platform webview is missing (no WebView2 runtime, no
    /// webkit2gtk); the caller falls back to the browser, which serves the
    /// same UI, so the feature degrades instead of dying.
    pub fn open<T>(target: &EventLoopWindowTarget<T>) -> Result<Self, String> {
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

        let webview = Self::attach_webview(&window)?;

        window.set_focus();
        Ok(Self {
            window,
            _webview: webview,
        })
    }

    /// Windows and macOS attach straight to the window handle.
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    fn attach_webview(window: &Window) -> Result<wry::WebView, String> {
        wry::WebViewBuilder::new()
            .with_url(api::ui_url())
            .build(window)
            .map_err(|e| format!("could not create the webview: {e}"))
    }

    /// Linux: tao windows are GTK, so the webview goes into the window's
    /// default vertical box rather than onto the raw handle.
    #[cfg(all(unix, not(target_os = "macos")))]
    fn attach_webview(window: &Window) -> Result<wry::WebView, String> {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .ok_or("the manager window has no GTK container to hold a webview")?;
        wry::WebViewBuilder::new()
            .with_url(api::ui_url())
            .build_gtk(vbox)
            .map_err(|e| format!("could not create the webview: {e}"))
    }

    pub fn id(&self) -> WindowId {
        self.window.id()
    }

    /// Bring an already-open window back to the front.
    pub fn focus(&self) {
        self.window.set_visible(true);
        self.window.set_focus();
    }
}
