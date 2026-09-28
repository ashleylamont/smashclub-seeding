import { useCallback, useState } from 'react';

/**
 * A boolean the browser remembers.
 *
 * Board settings have to survive navigation: every row on the rankings screen
 * is a link to a player, so "back" remounts the board. A plain `useState`
 * default would silently re-apply itself every time someone looked at a profile
 * and came back, which reads as the app fighting you.
 *
 * Reads and writes are wrapped: `localStorage` throws outright in some
 * privacy modes, and a preference is never worth taking the page down for.
 */
function read(key: string): boolean | null {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? null : stored === 'true';
  } catch {
    return null;
  }
}

export function useStoredFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  // Lazy initialiser, so storage is read once per mount rather than on every
  // render — and never as a side effect that has to correct itself afterwards.
  const [value, setValue] = useState(() => read(key) ?? fallback);

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // Preference not persisted; the session still honours it.
      }
    },
    [key],
  );

  return [value, set];
}
