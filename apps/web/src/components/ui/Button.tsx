import type { ComponentProps } from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';

type Props = ComponentProps<'button'> & {
  variant?: 'default' | 'primary' | 'danger' | 'plain';
  size?: 'default' | 'small';
  pending?: boolean;
  asChild?: boolean;
};

/** Native button semantics; form submission must be requested explicitly. */
export function Button({
  variant = 'default',
  size = 'default',
  pending = false,
  asChild = false,
  disabled,
  className = '',
  type = 'button',
  children,
  ...props
}: Props) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      {...props}
      type={type}
      className={`ui-button${variant === 'plain' ? '' : ` btn${variant === 'default' ? '' : ` btn-${variant}`}${size === 'small' ? ' btn-small' : ''}`} ${className}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending && <span className="ui-spinner" aria-hidden="true" />}
      <Slottable>{children}</Slottable>
    </Component>
  );
}
