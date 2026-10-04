import type { ComponentProps } from 'react';

type Props = ComponentProps<'button'> & {
  variant?: 'default' | 'primary' | 'danger';
  size?: 'default' | 'small';
  pending?: boolean;
};

/** Native button semantics; form submission must be requested explicitly. */
export function Button({
  variant = 'default',
  size = 'default',
  pending = false,
  disabled,
  className = '',
  type = 'button',
  children,
  ...props
}: Props) {
  return (
    <button
      {...props}
      type={type}
      className={`btn${variant === 'default' ? '' : ` btn-${variant}`}${size === 'small' ? ' btn-small' : ''} ${className}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending && <span className="ui-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
