import { useRef, useState } from 'react';
import type { Theme } from '../types';

const STORAGE_KEY = 'hypergate-theme';
const SWEEP_MS = 560;

/** The bit of the View Transitions API we need; not in TS's DOM lib yet. */
interface ViewTransition {
  ready: Promise<void>;
  finished: Promise<void>;
}
type TransitionDoc = Document & { startViewTransition?: (cb: () => void) => ViewTransition };

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Distance from (x, y) to the furthest viewport corner. */
function coverRadius(x: number, y: number): number {
  return Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
}

/**
 * One sun/moon button. Flipping the theme is painted as a circle of the new
 * palette growing out of the button until it covers the window: with the View
 * Transitions API the whole new page is revealed through that circle, and
 * without it a disc of the incoming background does the same job and the
 * palette swaps under it as it lands.
 */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const btn = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const next: Theme = theme === 'light' ? 'dark' : 'light';

  const apply = (t: Theme) => {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
  };

  const sweep = async () => {
    const el = btn.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!el || reduced || busy.current) { apply(next); return; }
    busy.current = true;
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const from = `circle(0px at ${x}px ${y}px)`;
    const to = `circle(${coverRadius(x, y)}px at ${x}px ${y}px)`;
    const timing: KeyframeAnimationOptions = { duration: SWEEP_MS, easing: 'cubic-bezier(.4, 0, .2, 1)' };

    const doc = document as TransitionDoc;
    if (typeof doc.startViewTransition === 'function') {
      const transition = doc.startViewTransition(() => apply(next));
      try {
        await transition.ready;
        document.documentElement.animate({ clipPath: [from, to] }, { ...timing, pseudoElement: '::view-transition-new(root)' });
      } catch { /* the transition was skipped; the theme still flipped */ }
      await transition.finished.catch(() => undefined);
      busy.current = false;
      return;
    }

    // No view transitions: grow the incoming background, then swap beneath it.
    const disc = document.createElement('div');
    disc.className = 'theme-sweep';
    disc.dataset.to = next;
    document.body.append(disc);
    try {
      await disc.animate({ clipPath: [from, to] }, timing).finished;
      apply(next);
      await disc.animate({ opacity: [1, 0] }, { duration: 160, easing: 'linear' }).finished;
    } finally {
      disc.remove();
      busy.current = false;
    }
  };

  const label = next === 'light' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      ref={btn}
      className="themetoggle"
      type="button"
      title={label}
      aria-label={label}
      onClick={() => void sweep()}
    >
      {theme === 'light' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.4 14.3A8.6 8.6 0 1 1 9.7 3.6a6.9 6.9 0 0 0 10.7 10.7Z" />
    </svg>
  );
}
