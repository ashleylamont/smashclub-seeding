import { describe, expect, it } from 'vitest';
import { filterInactive, isActive, type RankableRow } from '../src/lib/activity';

const NOW = Date.parse('2026-08-01T00:00:00.000Z');

/** A board row, as the server publishes it: delta already taken over the full field. */
const row = (
  playerId: string,
  rank: number,
  previousRank: number | null,
  lastPlayedDate = '2026-07-01',
): RankableRow => ({
  playerId,
  rank,
  previousRank,
  rankDelta: previousRank === null ? null : previousRank - rank,
  lastPlayedDate,
});

/** Same, but for someone who has not been seen in years. */
const stale = (playerId: string, rank: number, previousRank: number | null): RankableRow =>
  row(playerId, rank, previousRank, '2021-03-04');

const byId = (rows: RankableRow[]) => new Map(rows.map((r) => [r.playerId, r]));

describe('isActive', () => {
  it('counts a player who played inside the year', () => {
    expect(isActive('2025-08-02', NOW)).toBe(true);
  });

  it('drops a player who last played a year ago to the day', () => {
    expect(isActive('2025-08-01', NOW)).toBe(false);
  });

  it('drops a player who last played longer ago than that', () => {
    expect(isActive('2024-11-30', NOW)).toBe(false);
  });

  it('measures the year by calendar date, not 365 days', () => {
    // 2024 was a leap year, so the day after the cutoff is 366 days back.
    expect(isActive('2024-02-29', Date.parse('2025-02-28T12:00:00.000Z'))).toBe(true);
  });

  it('keeps a player rather than hiding them over an unreadable date', () => {
    expect(isActive('not-a-date', NOW)).toBe(true);
  });
});

describe('filterInactive', () => {
  it('leaves the board alone when the setting is off, but still counts the inactive', () => {
    const rows = [row('a', 1, 2), stale('b', 2, 1)];
    const result = filterInactive(rows, NOW, false);
    expect(result.rows).toEqual(rows);
    expect(result.inactiveCount).toBe(1);
  });

  it('returns the server ranks untouched when nobody is inactive', () => {
    const rows = [row('a', 1, 2), row('b', 2, 1)];
    expect(filterInactive(rows, NOW, true)).toEqual({ rows, inactiveCount: 0 });
  });

  it('drops inactive players and closes the gaps in the ranks', () => {
    const rows = [row('a', 1, 1), stale('gone', 2, 2), row('b', 3, 3), row('c', 4, 4)];
    const result = filterInactive(rows, NOW, true);
    expect(result.rows.map((r) => r.playerId)).toEqual(['a', 'b', 'c']);
    expect(result.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(result.inactiveCount).toBe(1);
  });

  it('shows no movement when the only thing that moved was an inactive player', () => {
    // `gone` climbed from third to first over the night, which pushed `a` and
    // `b` down one each on the published board. Among the players still
    // showing, neither of them moved at all.
    const rows = [stale('gone', 1, 3), row('a', 2, 1), row('b', 3, 2)];
    expect(rows.map((r) => r.rankDelta)).toEqual([2, -1, -1]);

    const result = filterInactive(rows, NOW, true);
    expect(result.rows.map((r) => r.rankDelta)).toEqual([0, 0]);
  });

  it('still reports movement that active players earned against each other', () => {
    // `b` passed `a`, and an inactive player sits between them throughout.
    const rows = [row('b', 1, 3), stale('gone', 2, 2), row('a', 3, 1)];
    const result = byId(filterInactive(rows, NOW, true).rows);
    expect(result.get('b')).toMatchObject({ rank: 1, previousRank: 2, rankDelta: 1 });
    expect(result.get('a')).toMatchObject({ rank: 2, previousRank: 1, rankDelta: -1 });
  });

  it('re-derives previous ranks so they too run 1..n', () => {
    const rows = [row('a', 1, 4), stale('gone', 2, 1), row('b', 3, 7), row('c', 4, 5)];
    const result = filterInactive(rows, NOW, true);
    expect(result.rows.map((r) => r.previousRank)).toEqual([1, 3, 2]);
    expect(result.rows.map((r) => r.rankDelta)).toEqual([0, 1, -1]);
  });

  it('leaves a newly rated player without an arrow', () => {
    const rows = [row('a', 1, 1), row('debut', 2, null), stale('gone', 3, 2)];
    const debut = byId(filterInactive(rows, NOW, true).rows).get('debut')!;
    expect(debut.previousRank).toBeNull();
    expect(debut.rankDelta).toBeNull();
  });

  it('survives a board where everyone has aged out', () => {
    const result = filterInactive([stale('a', 1, 1)], NOW, true);
    expect(result.rows).toEqual([]);
    expect(result.inactiveCount).toBe(1);
  });
});
