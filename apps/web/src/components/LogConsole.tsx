import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type LineKind = 'error' | 'warn' | 'tool' | 'result' | 'plain';

interface LogLine {
  n: number;
  text: string;
  kind: LineKind;
}

const ROW_H = 19; // px, fixed row height for windowing
const OVERSCAN = 8;

/** Classify a raw log line so the console can frame tool calls and surface errors. */
function classify(text: string): LineKind {
  const t = text.toLowerCase();
  if (/\b(error|err|fail(ed|ure)?|exception|fatal|panic)\b/.test(t)) return 'error';
  if (/\b(warn|warning|deprecat)/.test(t)) return 'warn';
  if (/(→|->|\bcall(ing)?\b|\binvoke\b|\btool[_/ ]?call\b|"method"|\brpc\b|tools\/call)/.test(t)) return 'tool';
  if (/(←|<-|\bresult\b|\bresponse\b|"result"|\bok\b|✓)/.test(t)) return 'result';
  return 'plain';
}

const KIND_GLYPH: Record<LineKind, string> = {
  error: '✖',
  warn: '▲',
  tool: '→',
  result: '←',
  plain: '·',
};

/**
 * A Brainless-style console surface for server logs: monospace, framed
 * tool-call / result / error lines, a line-number gutter, and windowed
 * (virtualized) rendering so long buffers stay cheap. Auto-follows the tail
 * while the viewport is pinned to the bottom.
 */
export function LogConsole({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(220);
  const pinnedRef = useRef(true);

  const items = useMemo<LogLine[]>(
    () => lines.map((text, i) => ({ n: i + 1, text, kind: classify(text) })),
    [lines],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
  }, []);

  // Follow the tail when pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const total = items.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = items.slice(start, end);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
  };

  const errors = items.filter((l) => l.kind === 'error').length;

  return (
    <div className="console" role="group" aria-label="Server logs">
      <div className="console-bar">
        <span className="console-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="console-title mono">logs</span>
        <span className="console-count small muted">{items.length} lines{errors > 0 ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div ref={scrollRef} className="console-scroll" onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {items.length === 0 ? (
          <div className="console-empty small muted">(no output yet)</div>
        ) : (
          <div className="console-inner" style={{ height: total }}>
            <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
              {visible.map((l) => (
                <div key={l.n} className={`console-line k-${l.kind}`} style={{ height: ROW_H }}>
                  <span className="console-gutter" aria-hidden="true">{l.n}</span>
                  <span className="console-glyph" aria-hidden="true">{KIND_GLYPH[l.kind]}</span>
                  <span className="console-text">{l.text || '\u00a0'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
