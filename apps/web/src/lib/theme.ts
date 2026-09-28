/**
 * Colour-scheme preference.
 *
 * `index.css` has always carried a full printed-results light palette behind
 * `[data-theme]`, but nothing in the app ever set that attribute — the only way
 * to see light mode was to change the OS preference. This is the missing half:
 * a three-state preference (follow the OS, or pin one), persisted, applied to
 * `<html>`.
 *
 * It is a module-level store read through `useSyncExternalStore` rather than
 * `useState(() => localStorage…)`, because reading storage or the DOM during
 * render is exactly the impurity the app already had to fix once (see
 * `lib/useNow.ts`). The initial read happens at import time; render only ever
 * reads a plain variable.
 *
 * `index.html` applies the stored value before first paint, so a pinned light
 * theme does not flash the dark field on load. This module has to agree with
 * that inline script — same key, same attribute.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'smashclub:theme';

const listeners = new Set<() => void>();

function isMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readStored(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isMode(stored) ? stored : 'system';
  } catch {
    // Private-mode Safari and friends throw on access rather than returning null.
    return 'system';
  }
}

function apply(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

let mode: ThemeMode = typeof document === 'undefined' ? 'system' : readStored();

/** Snapshot for `useSyncExternalStore`; must be a stable reference per state. */
export function getThemeMode(): ThemeMode {
  return mode;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // A preference we cannot persist still applies for this session.
  }
  apply(next);
  for (const listener of listeners) listener();
}

/** Cycle order matches the toggle's label: Auto → Light → Dark → Auto. */
export function nextThemeMode(current: ThemeMode): ThemeMode {
  return current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
}

export const THEME_LABELS: Record<ThemeMode, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/** A glyph that reads at 11px: half-filled for "follow the OS". */
export const THEME_GLYPHS: Record<ThemeMode, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};
