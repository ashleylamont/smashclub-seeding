export const dispatchShortcuts = [
  { digit: 1, action: 'findPairing', label: 'Find a pairing' },
  { digit: 2, action: 'focusScore', label: 'Focus score editor' },
  { digit: 3, action: 'readyQueue', label: 'Go to the ready queue' },
] as const;
export type ShortcutAction = (typeof dispatchShortcuts)[number]['action'];

export function dispatchShortcut(action: ShortcutAction) {
  const shortcut = dispatchShortcuts.find((shortcut) => shortcut.action === action);
  return shortcut && `Control+Shift+${shortcut.digit}`;
}

export function focusDispatchTarget(target: HTMLElement | null) {
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'center' });
  return true;
}
