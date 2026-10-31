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
  it('keeps existing sources on gameplay and bounds supported timing choices', () => {
    expect(broadcastPresentation('')).toBe('gameplay');
    expect(broadcastPresentation('?presentation=auto')).toBe('auto');
    expect(broadcastPresentation('?presentation=progress')).toBe('progress');
    expect(broadcastPresentation('?presentation=unknown')).toBe('gameplay');
    for (const value of ['', 'NaN', 'Infinity', '-1', '0', '1', '999', '30'])
      expect(progressInterval(`?cycleSeconds=${value}`)).toBe(30);
    expect(progressInterval('?cycleSeconds=15')).toBe(15);
    expect(progressInterval('?cycleSeconds=60')).toBe(60);
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
});
