import { describe, expect, it } from 'vitest';
import { searchPlayers, type SearchablePlayer } from '../src/lib/playerSearch';

const player = (overrides: Partial<SearchablePlayer> & { canonicalName: string }): SearchablePlayer => ({
  id: overrides.canonicalName.toLowerCase().replace(/\s+/g, '-'),
  displayName: null,
  companyCode: null,
  aliases: [],
  status: 'active',
  ...overrides,
});

const pool: SearchablePlayer[] = [
  player({ canonicalName: 'Fox McCloud', displayName: 'starfox', aliases: ['fox', 'fox m'] }),
  player({ canonicalName: 'Falco Lombardi', aliases: ['falco'] }),
  player({ canonicalName: 'Samus Aran', aliases: ['sammy'] }),
  player({ canonicalName: 'Old Account', status: 'merged', aliases: ['fox legacy'] }),
];

describe('searchPlayers', () => {
  it('lists everyone alphabetically for an empty query', () => {
    expect(searchPlayers(pool, '').map((match) => match.player.canonicalName)).toEqual([
      'Falco Lombardi',
      'Fox McCloud',
      'Samus Aran',
    ]);
  });

  it('never offers a merged player', () => {
    expect(searchPlayers(pool, 'fox').map((match) => match.player.canonicalName)).not.toContain('Old Account');
    expect(searchPlayers(pool, 'old account')).toEqual([]);
  });

  it('matches the registry name, the public alias, and stored aliases', () => {
    expect(searchPlayers(pool, 'mccloud')[0]!.player.canonicalName).toBe('Fox McCloud');
    expect(searchPlayers(pool, 'starfox')[0]!.player.canonicalName).toBe('Fox McCloud');
    expect(searchPlayers(pool, 'sammy')[0]!.player.canonicalName).toBe('Samus Aran');
  });

  it('reports the alias that matched, and only when it was an alias', () => {
    expect(searchPlayers(pool, 'sammy')[0]!.matchedAlias).toBe('sammy');
    expect(searchPlayers(pool, 'samus')[0]!.matchedAlias).toBeNull();
    // The hit is on the public alias, which the row already shows.
    expect(searchPlayers(pool, 'starfox')[0]!.matchedAlias).toBeNull();
  });

  it('ranks exact over prefix over substring', () => {
    const ranked = searchPlayers(
      [
        player({ canonicalName: 'Falcon Punch' }),
        player({ canonicalName: 'Captain Falco' }),
        player({ canonicalName: 'Falco' }),
      ],
      'falco',
    );
    expect(ranked.map((match) => match.player.canonicalName)).toEqual(['Falco', 'Falcon Punch', 'Captain Falco']);
  });

  it('caps the result list', () => {
    const many = Array.from({ length: 40 }, (_, index) => player({ canonicalName: `Player ${index}` }));
    expect(searchPlayers(many, 'player', 25)).toHaveLength(25);
  });
});
