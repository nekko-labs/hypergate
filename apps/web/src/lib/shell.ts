/**
 * The desktop shell, as seen from the page.
 *
 * One UI, two frames: this bundle is what the daemon serves at `/`, so it runs
 * both in a browser tab and inside the native manager window. The window has
 * no OS title bar — the page's own top bar is it — which means everything a
 * frame used to provide has to come from here instead.
 *
 * `window.__hypergateShell` is injected by the shell before the page loads
 * (`apps/shell/src/window.rs`). Its absence is how the page knows it is in a
 * browser, where the tab already has chrome and none of this applies.
 */

import type { MouseEvent } from 'react';

export interface ShellInfo {
  platform: 'windows' | 'macos' | 'linux';
  /**
   * Whether the page draws the minimise/maximise/close buttons. False on
   * macOS, where the traffic lights are still the OS's and float over our
   * transparent title bar.
   */
  buttons: boolean;
  titleBarHeight: number;
}

interface ShellWindow extends Window {
  __hypergateShell?: ShellInfo;
  ipc?: { postMessage: (message: string) => void };
  /** Set by the window controls; the shell calls it whenever the window resizes. */
  __hypergateOnWindowState?: (state: { maximized: boolean }) => void;
}

/** The shell, or `undefined` in a browser tab. */
export const shell: ShellInfo | undefined = (window as ShellWindow).__hypergateShell;

/** Whether the page is responsible for its own title bar. */
export const inShell = Boolean(shell);

/** Send one of the messages `window.rs` understands. Silent in a browser. */
export function tellShell(message: string): void {
  (window as ShellWindow).ipc?.postMessage(message);
}

/**
 * Start an OS window-move gesture from a mousedown on the title bar.
 *
 * Not `-webkit-app-region: drag`: support for it across WebView2, WKWebView
 * and WebKitGTK is uneven, and the shell can do the same job through
 * `drag_window()` on every one of them. The pointer is still down when the
 * message arrives, which is what makes the gesture continue.
 *
 * Ignores anything that starts on a control — a drag region that eats clicks
 * on the buttons sitting in it is worse than no drag region.
 */
export function beginWindowDrag(e: MouseEvent): void {
  if (!inShell || e.button !== 0) return;
  if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"], .no-drag')) return;
  tellShell('window:drag');
}

/** Double-clicking the title bar toggles maximise, as a frame would. */
export function toggleMaximizeOnDoubleClick(e: MouseEvent): void {
  if (!inShell) return;
  if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"], .no-drag')) return;
  tellShell('window:maximize');
}
