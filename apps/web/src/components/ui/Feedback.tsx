import type { ReactNode } from 'react';

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
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
