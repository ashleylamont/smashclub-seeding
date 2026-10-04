import { useState, type ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-alert-dialog';
import { Button } from './Button';

/** The caller owns confirmation, pending mutations and when the dialog closes. */
export function ConfirmDialog({
  title,
  description,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="ui-dialog-overlay" />
        <Primitive.Content
          className="modal ui-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener?.isConnected) opener.focus();
          }}
        >
          <Primitive.Title asChild>
            <h2>{title}</h2>
          </Primitive.Title>
          <Primitive.Description asChild>
            <div>{description}</div>
          </Primitive.Description>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function ConfirmCancel({
  children = 'Cancel',
  onClick,
}: {
  children?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Primitive.Cancel asChild>
      <Button onClick={onClick}>{children}</Button>
    </Primitive.Cancel>
  );
}
