import { useMemo, useState } from 'react';
import { CHARACTERS, MAX_CHARACTERS_PER_PLAYER, characterName } from '@smashclub/shared';
import { CharacterIcons } from './CharacterIcons';
import './CharacterPicker.css';

/**
 * Pick the fighters a player mains.
 *
 * Selection order is meaningful — the first slug is the main and leads the icon
 * strip everywhere it is drawn — so the chosen set is shown as an ordered row
 * that can be reordered, not as a set of ticked boxes. The grid below it stays
 * in character-select order rather than alphabetical, because that is the order
 * players actually know the roster in.
 */

interface Props {
  value: string[];
  onChange: (slugs: string[]) => void;
  max?: number;
}

export function CharacterPicker({ value, onChange, max = MAX_CHARACTERS_PER_PLAYER }: Props) {
  const [filter, setFilter] = useState('');

  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return CHARACTERS;
    return CHARACTERS.filter(
      (character) =>
        character.name.toLowerCase().includes(query) ||
        character.slug.includes(query) ||
        (character.aka ?? []).some((alt) => alt.toLowerCase().includes(query)),
    );
  }, [filter]);

  const full = value.length >= max;

  const toggle = (slug: string) => {
    if (value.includes(slug)) {
      onChange(value.filter((entry) => entry !== slug));
    } else if (!full) {
      onChange([...value, slug]);
    }
  };

  /** Promote to main — the quickest fix for "right characters, wrong order". */
  const makeMain = (slug: string) => {
    onChange([slug, ...value.filter((entry) => entry !== slug)]);
  };

  return (
    <div className="character-picker">
      <div className="character-picker-selected">
        {value.length === 0 ? (
          <span className="muted">No characters selected.</span>
        ) : (
          value.map((slug, index) => (
            <span key={slug} className={`selected-character${index === 0 ? ' is-main' : ''}`}>
              <CharacterIcons slugs={[slug]} />
              <span className="selected-character-name">{characterName(slug)}</span>
              {index === 0 ? (
                <span className="chip chip-accent selected-main-chip">main</span>
              ) : (
                <button
                  type="button"
                  className="link-button"
                  title="Make this the main"
                  onClick={() => makeMain(slug)}
                >
                  make main
                </button>
              )}
              <button
                type="button"
                className="selected-character-remove"
                aria-label={`Remove ${characterName(slug)}`}
                onClick={() => toggle(slug)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <input
        className="input character-picker-filter"
        placeholder="Filter characters…"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />

      <div className="character-grid">
        {matches.map((character) => {
          const selected = value.includes(character.slug);
          return (
            <button
              key={character.slug}
              type="button"
              className={`character-option${selected ? ' is-selected' : ''}`}
              // A full selection greys out only the *unselected* options, so
              // deselecting is always still possible at the limit.
              disabled={!selected && full}
              aria-pressed={selected}
              title={character.name}
              onClick={() => toggle(character.slug)}
            >
              <CharacterIcons slugs={[character.slug]} loading="eager" />
              <span className="character-option-name">{character.name}</span>
            </button>
          );
        })}
        {matches.length === 0 && <p className="muted">No characters match “{filter}”.</p>}
      </div>

      <p className="muted character-picker-hint">
        {value.length}/{max} selected. The first is shown as the main.
      </p>
    </div>
  );
}
