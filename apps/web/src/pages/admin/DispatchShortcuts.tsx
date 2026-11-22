import { useEffect, useEffectEvent, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';

import { dispatchShortcuts, type ShortcutAction } from './dispatchKeyboard';

export function DispatchShortcuts({
  active,
  actions,
}: {
  active: boolean;
  actions: Record<ShortcutAction, () => boolean>;
}) {
  const [open, setOpen] = useState(false);
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      open ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      !event.ctrlKey ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    // Shift changes the printed character, so match the top-row number keys.
    const shortcut = dispatchShortcuts.find(({ digit }) => event.code === `Digit${digit}`);
    if (!shortcut) return;
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      (target !== document.body && !target.closest('.ops-page')) ||
      target.isContentEditable ||
      target.closest(
        'input, textarea, select, [role="textbox"], [role="spinbutton"], [role="combobox"]',
      ) ||
      document.querySelector(
        ':is([role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"])[data-state="open"]',
      )
    )
      return;
    if (actions[shortcut.action]()) event.preventDefault();
  });
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => onShortcut(event);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active]);

  return (
    <Dialog
      title="Keyboard shortcuts"
      open={open}
      onOpenChange={setOpen}
      description="Use these in Run matches outside fields, menus, and dialogs. Choose Score / details to select a match."
      trigger={<Button size="small">Keyboard shortcuts</Button>}
    >
      <dl className="dispatch-shortcut-list">
        {dispatchShortcuts.map(({ action, digit, label }) => (
          <div key={action}>
            <dt>{label}</dt>
            <dd>
              <kbd>Ctrl + Shift + {digit}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
