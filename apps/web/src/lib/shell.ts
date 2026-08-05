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
 * Anything that would rather have the click than the window would.
 *
 * A drag region that eats clicks on the buttons sitting in it is worse than
 * no drag region at all.
 */
function isControl(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest('button, a, input, select, [role="button"], .no-drag'));
}

/**
 * The title bar's whole pointer contract: press to move the window, press
 * twice to maximise.
 *
 * **Both live on mousedown**, which looks odd and is the only thing that
 * works. The first press hands the pointer to the OS move loop, and that loop
 * owns the mouse until the button comes up — so a `dblclick` listener on this
 * element never fires, and double-clicking the bar would do nothing at all.
 * The second press does still arrive, carrying `detail === 2`, which is what
 * we answer here instead.
 *
 * Moving is `drag_window()` over IPC rather than `-webkit-app-region: drag`:
 * support for the CSS property across WebView2, WKWebView and WebKitGTK is
 * uneven, while the shell can do the same job on all three. The pointer is
 * still down when the message lands, which is what continues the gesture.
 */
export function onTitleBarMouseDown(e: MouseEvent): void {
  if (!inShell || e.button !== 0 || isControl(e.target)) return;
  tellShell(e.detail >= 2 ? 'window:maximize' : 'window:drag');
}
