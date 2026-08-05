import { useEffect, useState } from 'react';
import { shell, tellShell } from '../lib/shell';

/**
 * Minimise, maximise and close, drawn by the page.
 *
 * The manager window has no OS frame on Windows and Linux, so these are the
 * only way out of it besides Alt+F4 — which is the point: the buttons now sit
 * in the app's own background, on the top bar's line, instead of in a strip of
 * system chrome above it.
 *
 * Nothing renders on macOS (the traffic lights are still the OS's, floating
 * over a transparent title bar) or in a browser tab, so the same bundle serves
 * all three frames.
 *
 * The glyphs are the Windows convention — a bar, a square, an X, hairline
 * weight — because that is what a window's buttons are expected to look like
 * wherever we are drawing them ourselves.
 */
export function WindowButtons() {
  const [maximized, setMaximized] = useState(false);

  // The window can be maximised without going through us: snapped to half the
  // screen, double-clicked on the title bar, dragged to the top edge. The
  // shell pushes the answer after every resize.
  useEffect(() => {
    const w = window as Window & { __hypergateOnWindowState?: (s: { maximized: boolean }) => void };
    w.__hypergateOnWindowState = (state) => setMaximized(state.maximized);
    return () => { delete w.__hypergateOnWindowState; };
  }, []);

  if (!shell?.buttons) return null;

  return (
    <div className="win-buttons">
      <button
        className="win-btn"
        onClick={() => tellShell('window:minimize')}
        aria-label="Minimise"
        title="Minimise"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        className="win-btn"
        onClick={() => tellShell('window:maximize')}
        aria-label={maximized ? 'Restore' : 'Maximise'}
        title={maximized ? 'Restore' : 'Maximise'}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        className="win-btn win-btn-close"
        onClick={() => tellShell('window:close')}
        aria-label="Close"
        title="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
