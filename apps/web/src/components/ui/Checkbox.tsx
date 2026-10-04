import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-checkbox';

export function Checkbox({
  className = '',
  onCheckedChange,
  ...props
}: Omit<ComponentProps<typeof Primitive.Root>, 'onCheckedChange'> & {
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <Primitive.Root
      {...props}
      onCheckedChange={(checked) => onCheckedChange?.(checked === true)}
      className={`ui-checkbox ${className}`}
    >
      <Primitive.Indicator className="ui-checkbox-mark" aria-hidden="true" />
    </Primitive.Root>
  );
}
