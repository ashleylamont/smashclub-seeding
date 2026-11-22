// Modified digits are reserved for workspace switching in Vivaldi and capture in some browsers.
export const dispatchShortcuts = [
  { key: 'F7', action: 'findPairing', label: 'Find a pairing' },
  { key: 'F8', action: 'focusScore', label: 'Focus score editor' },
  { key: 'F9', action: 'readyQueue', label: 'Go to the ready queue' },
] as const;
export type ShortcutAction = (typeof dispatchShortcuts)[number]['action'];

export function dispatchShortcut(action: ShortcutAction) {
  const shortcut = dispatchShortcuts.find((shortcut) => shortcut.action === action);
  return shortcut && `Control+Shift+${shortcut.key}`;
}

export function focusDispatchTarget(target: HTMLElement | null) {
  if (!target) return false;
  target.focus({ preventScroll: true });
  const tabs = target.closest('.ops-page')?.querySelector<HTMLElement>('.ops-workspace-nav');
  if (!tabs) {
    target.scrollIntoView({ block: 'center' });
    return true;
  }
  // The sticky tab bar's top already includes the measured application header.
  const tabStyle = getComputedStyle(tabs);
  const stickyBottom = Number.parseFloat(tabStyle.top) + tabs.getBoundingClientRect().height;
  const gap = Number.parseFloat(tabStyle.getPropertyValue('--s2'));
  const rect = target.getBoundingClientRect();
  const centered = (document.documentElement.clientHeight - rect.height) / 2;
  const visibleTop = Math.max(centered, stickyBottom + gap);
  window.scrollBy({ top: rect.top - visibleTop, behavior: 'instant' });
  return true;
}
