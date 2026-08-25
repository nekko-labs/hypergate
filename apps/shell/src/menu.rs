//! The macOS application menu, which exists so that Cmd+V works.
//!
//! # Why a menu bar at all
//!
//! The manager window draws its own title bar and has no toolbar, so on the
//! face of it an app menu is pure chrome we do not want. It is not optional on
//! macOS, for a reason that has nothing to do with menus: **AppKit routes the
//! standard editing shortcuts through menu key equivalents.** `Cmd+V` is
//! delivered to the key window only because some menu item claims it and sends
//! `paste:` down the responder chain. An app with no `NSMenu` claims nothing,
//! so the keystroke is swallowed before WKWebView ever hears about it.
//!
//! The symptom is specific and was reported exactly this way: pasting into the
//! credential fields did nothing, while right-clicking and choosing Paste
//! worked. Those are two different mechanisms. The context menu is WebKit's
//! own, built inside the web content process, which is why it never needed us.
//! The keyboard path needs a menu bar, and we had none.
//!
//! So the menu is deliberately minimal: the items macOS expects an app to have,
//! and the Edit items that make the keyboard work. No Hypergate-specific
//! commands live here, because the page is the UI and duplicating its controls
//! into a menu would create two places to keep in step.
//!
//! Windows and Linux are untouched. Their webviews handle `Ctrl+V` themselves,
//! and both draw the window without an OS frame (see `window.rs`), so adding a
//! menu bar would put a strip of OS chrome above a title bar built to replace
//! exactly that.

#[cfg(target_os = "macos")]
use muda::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

#[cfg(target_os = "macos")]
use crate::icon;

/// Build and install the application menu.
///
/// Call once, after the event loop exists (which is what creates `NSApp`) and
/// before the window is shown. Errors are returned rather than swallowed so the
/// caller can log them; a missing menu is not fatal, it just costs the
/// shortcuts, so no caller should treat this as a hard failure.
#[cfg(target_os = "macos")]
pub fn install() -> Result<(), String> {
    let menu = Menu::new();

    // The application menu. On macOS the first submenu is *always* the app
    // menu, whatever it is titled, and the system renames it to the process
    // name; the title here is what shows if that lookup ever fails.
    let about = AboutMetadata {
        name: Some("Hypergate".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("Nekko Labs".into()),
        website: Some("https://hypergate.app".into()),
        icon: icon::menu_icon().ok(),
        ..Default::default()
    };
    let app_menu = Submenu::new("Hypergate", true);
    app_menu
        .append_items(&[
            &PredefinedMenuItem::about(Some("About Hypergate"), Some(about)),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::services(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::show_all(None),
            &PredefinedMenuItem::separator(),
            // Quit, not "close to tray": the tray icon's own menu owns that
            // decision, and a Cmd+Q that hid the app would be a lie.
            &PredefinedMenuItem::quit(None),
        ])
        .map_err(|e| format!("could not build the application menu: {e}"))?;

    // The reason this file exists. Every item here is a `PredefinedMenuItem`,
    // which means muda attaches the standard AppKit selector *and* the standard
    // key equivalent, so the responder chain does the work and we implement
    // nothing.
    let edit_menu = Submenu::new("Edit", true);
    edit_menu
        .append_items(&[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ])
        .map_err(|e| format!("could not build the Edit menu: {e}"))?;

    // Minimise and zoom by keyboard, which the frameless window otherwise has
    // no shortcut for: its buttons are the page's, and on macOS the traffic
    // lights are the only native control left.
    let window_menu = Submenu::new("Window", true);
    window_menu
        .append_items(&[
            &PredefinedMenuItem::minimize(None),
            &PredefinedMenuItem::maximize(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::close_window(None),
        ])
        .map_err(|e| format!("could not build the Window menu: {e}"))?;

    menu.append_items(&[&app_menu, &edit_menu, &window_menu])
        .map_err(|e| format!("could not assemble the menu bar: {e}"))?;

    menu.init_for_nsapp();
    // Tells AppKit which submenu owns the window list, so "Bring All to Front"
    // and the window roster work the way they do in every other Mac app.
    window_menu.set_as_windows_menu_for_nsapp();

    // The menu bar must outlive this function. NSApp retains the *native*
    // NSMenu, but every NSMenuItem holds a raw pointer back into muda's own
    // item data, which lives only as long as these Rust handles: `Menu` even
    // has a Drop impl that detaches that bookkeeping. Dropping `menu` here
    // therefore left the About item pointing at freed memory, and clicking it
    // crashed the app whenever the allocator had reused that memory (the Edit
    // items never noticed, because their standard AppKit selectors never call
    // back into Rust). The menu is installed once and lives as long as the
    // process, so leaking the handle is the correct lifetime, not a shortcut.
    std::mem::forget(menu);
    Ok(())
}

/// Nothing to install: these platforms get their editing shortcuts from the
/// webview, and neither draws an OS frame for a menu bar to sit in.
#[cfg(not(target_os = "macos"))]
pub fn install() -> Result<(), String> {
    Ok(())
}
