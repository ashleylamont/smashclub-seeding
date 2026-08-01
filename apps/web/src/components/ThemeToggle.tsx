import { useSyncExternalStore } from 'react';
import {
  THEME_GLYPHS,
  THEME_LABELS,
  getThemeMode,
  nextThemeMode,
  setThemeMode,
  subscribeTheme,
} from '../lib/theme';

/**
 * Colour-scheme control: one button that names its *current* state and cycles
 * Auto → Light → Dark.
 *
 * A cycling button has to say where it is, not where it will go, or nobody can
 * tell "Light" from "switch to light" — so the visible label is the current
 * mode and the accessible name spells out both halves. The word is dropped on
 * narrow screens where the nav has no room for it; the glyph and the accessible
 * name stay.
 */
export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribeTheme, getThemeMode, () => 'system' as const);
  const next = nextThemeMode(mode);

  return (
    <button
      type="button"
      className="btn btn-small theme-toggle"
      aria-label={`Theme: ${THEME_LABELS[mode].toLowerCase()}. Switch to ${THEME_LABELS[next].toLowerCase()}.`}
      title={`Theme: ${THEME_LABELS[mode]} — click for ${THEME_LABELS[next]}`}
      onClick={() => setThemeMode(next)}
    >
      <span aria-hidden="true">{THEME_GLYPHS[mode]}</span>
      <span className="theme-toggle-label" aria-hidden="true">
        {THEME_LABELS[mode]}
      </span>
    </button>
  );
}
