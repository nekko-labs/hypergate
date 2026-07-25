import type { ReactNode } from 'react';

/**
 * Shared empty / loading state, so the Servers list and Analytics (and anywhere
 * else) present the same panel-wrapped, centered treatment.
 */
export function EmptyState({
  glyph,
  title,
  children,
  action,
  loading,
}: {
  glyph: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="empty">
        <div className={`cat ${loading ? 'is-loading' : ''}`}>{glyph}</div>
        <b>{title}</b>
        {children && <div className="small" style={{ marginTop: 4, maxWidth: 380, marginInline: 'auto' }}>{children}</div>}
        {action && <div style={{ marginTop: 14 }}>{action}</div>}
      </div>
    </div>
  );
}
