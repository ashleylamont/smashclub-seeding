import { useState, type ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { Button } from './Button';

/** Also supports existing conditionally mounted modal callers without a Trigger. */
export function Dialog({
  title,
  description,
  children,
  open,
  onOpenChange,
  trigger,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  wide?: boolean;
}) {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>}
      <Primitive.Portal>
        <Primitive.Overlay className="ui-dialog-overlay" />
        <Primitive.Content
          className={`modal ui-dialog${wide ? ' modal-wide' : ''}`}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          onCloseAutoFocus={
            trigger
              ? undefined
              : (event) => {
                  event.preventDefault();
                  if (opener?.isConnected) opener.focus();
                }
          }
        >
          <div className="ui-dialog-heading">
            <Primitive.Title asChild>
              <h2>{title}</h2>
            </Primitive.Title>
            <Primitive.Close asChild>
              <Button size="small" aria-label="Close dialog">
                ×
              </Button>
            </Primitive.Close>
          </div>
          {description && (
            <Primitive.Description className="ui-dialog-description">
              {description}
            </Primitive.Description>
          )}
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
