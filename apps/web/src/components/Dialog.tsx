import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Number of open dialogs, so the app background is only made inert once. */
let openCount = 0;
function setAppInert(inert: boolean) {
  const root = document.getElementById('root');
  if (!root) return;
  if (inert) {
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
  } else {
    root.removeAttribute('inert');
    root.removeAttribute('aria-hidden');
  }
}

interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Max width of the panel in px. */
  width?: number;
  /** Extra description text shown under the title (also announced via aria). */
  description?: ReactNode;
}

/**
 * Accessible modal dialog: role="dialog" + aria-modal, focus moves in on open
 * and returns to the trigger on close, Escape closes, Tab is trapped inside,
 * and the rest of the app is made `inert`/`aria-hidden` while open.
 */
export function Dialog({ title, onClose, children, width = 560, description }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    openCount += 1;
    if (openCount === 1) setAppInert(true);

    const panel = panelRef.current;
    // Move focus into the dialog (first focusable, else the panel itself).
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === panel)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      openCount -= 1;
      if (openCount === 0) setAppInert(false);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        style={{ maxWidth: width }}
      >
        <div className="modal-head">
          <h2 id={titleId} className="modal-title">{title}</h2>
          <button className="btn sm btn-ghost modal-x" aria-label="Close dialog" onClick={onClose}>✕</button>
        </div>
        {description && <p id={descId} className="small muted modal-desc">{description}</p>}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
