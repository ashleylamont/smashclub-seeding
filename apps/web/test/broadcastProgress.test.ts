import { describe, expect, it } from 'vitest';
import {
  broadcastPresentation,
  broadcastProgressPages,
  progressInterval,
  type ProgressData,
} from '../src/lib/broadcastProgress';
import { liveBracketRound } from '../src/lib/eventBracket';
import { bracketFixture, TEAM_ALIAS } from './fixtures/brackets';

const fixture = (size = 16, double = true): ProgressData => ({
  plan: { id: 'night', name: 'Tech In Place', status: 'underway' },
  matches: bracketFixture(size, double),
  nativeBrackets: [
    {
      id: 'rehearsal',
      division: 'upper',
      stage: 'main',
      entrantIds: Array.from({ length: size }, (_, i) => `entrant-${i}`),
      complete: false,
      winnerId: null,
      standings: [],
    },
  ],
  entrants: [],
});

describe('OBS intermission source choices and bounded pages', () => {
  it('defaults to Auto and ten seconds while keeping explicit source settings', () => {
    for (const search of ['', '?presentation=', '?presentation=unknown'])
      expect(broadcastPresentation(search)).toBe('auto');
    for (const mode of ['auto', 'gameplay', 'progress'])
      expect(broadcastPresentation(`?presentation=${mode}`)).toBe(mode);
    expect(progressInterval('')).toBe(10);
    for (const value of ['', 'NaN', 'Infinity', '-1', '0', '1', '999'])
      expect(progressInterval(`?cycleSeconds=${value}`)).toBe(10);
    for (const seconds of [10, 15, 30, 60])
      expect(progressInterval(`?cycleSeconds=${seconds}`)).toBe(seconds);
  });

  it.each([
    [5, false],
    [16, false],
    [7, true],
    [32, true],
  ] as const)(
    'covers every %i-entrant graph match with at most two cards per column (DE=%s)',
    (size, double) => {
      const data = fixture(size, double);
      const original = structuredClone(data);
      const pages = broadcastProgressPages(data);
      const draws = pages.filter((page) => page.kind === 'bracket');
      expect(new Set(draws.flatMap((page) => page.matches.map((match) => match.id)))).toEqual(
        new Set(data.matches.map((match) => match.id)),
      );
      expect(new Set(pages.map((page) => page.key)).size).toBe(pages.length);
      for (const page of draws) {
        const rounds = [...new Set(page.matches.map(liveBracketRound))];
        expect(rounds.length).toBeLessThanOrEqual(2);
        for (const round of rounds)
          expect(
            page.matches.filter((match) => liveBracketRound(match) === round).length,
          ).toBeLessThanOrEqual(2);
      }
      expect(draws.some((page) => page.roundTitles.includes('Reset · if needed'))).toBe(double);
      expect(data).toEqual(original);
    },
  );

  it('uses one card per column for long doubles names without losing any matches', () => {
    const data = fixture(8);
    data.matches.forEach((match) => {
      if (match.player1Id) match.player1Name = TEAM_ALIAS;
      if (match.player2Id) match.player2Name = TEAM_ALIAS;
    });
    const draws = broadcastProgressPages(data).filter((page) => page.kind === 'bracket');
    for (const page of draws.filter((page) => page.lane.key === 'winners'))
      for (const round of new Set(page.matches.map(liveBracketRound)))
        expect(
          page.matches.filter((match) => liveBracketRound(match) === round).length,
        ).toBeLessThanOrEqual(1);
    expect(new Set(draws.flatMap((page) => page.matches.map((match) => match.id))).size).toBe(
      data.matches.length,
    );
  });

  it('paginates only visible imported matches from each linked scope beside native brackets', () => {
    const data = fixture(4, false);
    data.matches[0]!.sourceSetId = 'published-native-set';
    const linked = (id: string, division: string, stage: string) => ({
      ...data.matches[0]!,
      id,
      division,
      stage,
      sourceSetId: `set-${id}`,
      nativeBracketId: null,
    });
    const matches = Array.from({ length: 4 }, (_, index) =>
      linked(`lower-${index}`, 'lower', 'main'),
    );
    const consolation = linked('consolation', 'lower', 'consolation');
    data.matches.push(...matches, consolation, linked('unlinked', 'upper', 'consolation'), {
      ...linked('local', 'lower', 'main'),
      sourceSetId: null,
    });
    data.linkedBrackets = [
      { division: 'upper', stage: 'main', slug: 'published-native-results' },
      { division: 'lower', stage: 'main', slug: 'linked-main' },
      { division: 'lower', stage: 'consolation', slug: 'linked-consolation' },
      { division: 'upper', stage: 'consolation', slug: null },
    ];

    const pages = broadcastProgressPages(data);
    expect(pages.some((page) => page.kind === 'bracket')).toBe(true);
    expect(
      pages
        .filter((page) => page.kind === 'linked')
        .map(({ key, matches }) => ({ key, matches: matches.map(({ id }) => id) })),
    ).toEqual([
      { key: 'linked:lower:main:0', matches: ['lower-0', 'lower-1', 'lower-2'] },
      { key: 'linked:lower:main:1', matches: ['lower-3'] },
      { key: 'linked:lower:consolation:0', matches: ['consolation'] },
    ]);
  });

  it('keeps mixed-stage pools, all entrants and actual completed summaries without inventing winners', () => {
    const data = fixture(4);
    const base = data.matches[0]!;
    const pool = Array.from({ length: 8 }, (_, i) => ({
      ...base,
      id: `pool-${i}`,
      nativeBracketId: null,
      stage: 'group',
      poolIndex: 0,
      player1Id: `pool-player-${i}`,
      player1Name: `Player ${i}`,
      player2Id: `pool-player-${(i + 1) % 8}`,
      player2Name: `Player ${(i + 1) % 8}`,
      status: 'ready',
      outcome: null,
    }));
    data.matches.push(...pool);
    data.plan.status = 'complete';
    const pages = broadcastProgressPages(data);
    const pools = pages.filter((page) => page.kind === 'pool');
    expect(pools).toHaveLength(2);
    expect(new Set(pools.flatMap((page) => page.players.map((player) => player.id))).size).toBe(8);
    expect(pools.every((page) => page.players.length <= 6 && page.pool.complete === 0)).toBe(true);
    expect(pages.some((page) => page.kind === 'bracket')).toBe(true);
    expect(pages.at(-1)).toEqual({ kind: 'summary', key: 'summary' });
    expect(data.nativeBrackets[0]!.winnerId).toBeNull();
    expect(broadcastProgressPages({ ...data, matches: [], nativeBrackets: [] })).toEqual([
      { kind: 'summary', key: 'summary' },
    ]);
  });

  it('uses the confirmed round-robin standings in order and skips empty result records', () => {
    const data = fixture(8, false);
    data.plan = {
      ...data.plan,
      status: 'complete',
      bracketMode: 'native',
      structure: 'round_robin',
    };
    data.matches = [];
    const result = data.nativeBrackets[0]!;
    result.complete = true;
    result.winnerId = 'entrant-7';
    result.standings = [...result.entrantIds]
      .reverse()
      .map((playerId, i) => ({ playerId, place: i + 1 }));
    const pages = broadcastProgressPages(data);
    expect(pages.map(({ kind }) => kind)).toEqual([
      'round-robin-results',
      'round-robin-results',
      'summary',
    ]);
    const standingsPages = pages.filter(({ kind }) => kind === 'round-robin-results');
    expect(standingsPages.map(({ standings }) => standings.length)).toEqual([6, 2]);
    expect(standingsPages.flatMap(({ standings }) => standings)).toEqual(result.standings);
    expect(standingsPages.every(({ winnerId }) => winnerId === result.winnerId)).toBe(true);

    const cancelled = {
      ...data,
      plan: { ...data.plan, status: 'cancelled' },
      nativeBrackets: [{ ...result, complete: false, standings: [], winnerId: null }],
    };
    expect(broadcastProgressPages(cancelled)).toEqual([{ kind: 'summary', key: 'summary' }]);
    for (const plan of [
      { ...data.plan, structure: undefined },
      { ...data.plan, structure: 'round_robin_finals' },
      { ...data.plan, bracketMode: 'challonge' },
    ])
      expect(broadcastProgressPages({ ...data, plan })[0]?.kind).toBe('bracket');
  });
});
