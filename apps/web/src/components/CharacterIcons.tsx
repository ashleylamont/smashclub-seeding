import { useState } from 'react';
import { characterName } from '@smashclub/shared';
import './CharacterIcons.css';

/**
 * The head icons shown beside a player's name.
 *
 * Icons are optional assets (see tools/fetch-character-icons) rather than
 * something the app can assume is present, so each one falls back to a short
 * text badge when the file is missing. That keeps a half-populated icon
 * directory looking deliberate instead of showing broken-image glyphs, and it
 * means the feature is usable before any icon has been downloaded at all.
 */

interface Props {
  slugs: string[];
  /** `sm` sits inside a leaderboard row; `lg` heads a profile. */
  size?: 'sm' | 'lg';
  /**
   * Lazy by default, which is right for a long board. The picker overrides it:
   * its ninety icons are the content of the dialog, all on screen at once, and
   * deferring them just opens the form full of blanks that pop in.
   */
  loading?: 'lazy' | 'eager';
}

export function CharacterIcons({ slugs, size = 'sm', loading = 'lazy' }: Props) {
  if (slugs.length === 0) return null;
  return (
    <span className={`character-icons character-icons-${size}`}>
      {slugs.map((slug, index) => (
        <CharacterIcon
          key={slug}
          slug={slug}
          loading={loading}
          /* Only the first is the main, and only it is worth spelling out in
             the accessible name — the rest are secondaries. */
          label={index === 0 ? `Mains ${characterName(slug)}` : characterName(slug)}
        />
      ))}
    </span>
  );
}

function CharacterIcon({ slug, label, loading }: { slug: string; label: string; loading: 'lazy' | 'eager' }) {
  const [failed, setFailed] = useState(false);
  const name = characterName(slug);

  if (failed) {
    return (
      <span className="character-icon character-icon-fallback" title={label} aria-label={label} role="img">
        {abbreviate(name)}
      </span>
    );
  }

  return (
    <img
      className="character-icon"
      src={`/characters/${slug}.png`}
      alt={label}
      title={label}
      loading={loading}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Initials for the no-icon fallback: "Mr. Game & Watch" -> "MG", "Ike" -> "IK".
 * Two characters, so every badge is the same width as every other.
 */
function abbreviate(name: string): string {
  const words = name.split(/[\s&.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
