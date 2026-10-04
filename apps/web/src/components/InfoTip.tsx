import type { ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import './InfoTip.css';

/** Tap-accessible contextual help with collision handling and managed keyboard focus. */
export function InfoTip({
  label,
  children,
  align = 'start',
}: {
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <Popover.Root>
      <span className="info-tip">
        <Popover.Trigger className="info-tip-button" aria-label={`Explain: ${label}`}>
          <span aria-hidden="true">?</span>
        </Popover.Trigger>
      </span>
      <Popover.Portal>
        <Popover.Content
          className="info-tip-panel"
          sideOffset={8}
          align={align}
          collisionPadding={12}
          aria-label={label}
        >
          <span className="info-tip-title">{label}</span>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
