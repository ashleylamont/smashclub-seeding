import type { ComponentProps } from 'react';

/** Native progress semantics with the shared square, token-based appearance. */
export function Progress({
  label,
  className = '',
  ...props
}: Omit<ComponentProps<'progress'>, 'aria-label'> & { label: string }) {
  return <progress {...props} className={`ui-progress ${className}`} aria-label={label} />;
}
