import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-switch';

export function Switch({ className = '', ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root {...props} className={`ui-switch ${className}`}>
      <Primitive.Thumb className="ui-switch-thumb" />
    </Primitive.Root>
  );
}
