import type { ReactNode } from 'react';

export function Notice({
  tone = 'info',
  live = true,
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  /** Use false when a persistent parent live region already announces updates. */
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`banner banner-${tone}`}
      role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}
    >
      {children}
    </div>
  );
}

export function LoadingState({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <p className="ui-loading" role="status">
      <span className="ui-spinner" aria-hidden="true" />
      {children}
    </p>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="ui-empty card" aria-label={title}>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </section>
  );
}
