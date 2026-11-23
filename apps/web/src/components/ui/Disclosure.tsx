import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-collapsible';

export function Disclosure({
  title,
  children,
  className = '',
  triggerClassName = '',
  defaultOpen = false,
  mountWhenClosed = true,
  ...props
}: Omit<ComponentProps<typeof Primitive.Root>, 'title' | 'open' | 'onOpenChange'> & {
  title: ReactNode;
  triggerClassName?: string;
  mountWhenClosed?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    const expand = () => setOpen(true);
    element?.addEventListener('ui:expand', expand);
    return () => element?.removeEventListener('ui:expand', expand);
  }, []);
  return (
    <Primitive.Root
      {...props}
      ref={root}
      open={open}
      onOpenChange={setOpen}
      className={`ui-disclosure ${className}`}
      data-disclosure=""
    >
      <Primitive.Trigger className={`ui-disclosure-trigger ${triggerClassName}`}>
        <span className="ui-disclosure-icon" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="ui-disclosure-label">{title}</span>
      </Primitive.Trigger>
      <Primitive.Content
        forceMount={mountWhenClosed || undefined}
        className="ui-disclosure-content"
      >
        {children}
      </Primitive.Content>
    </Primitive.Root>
  );
}
