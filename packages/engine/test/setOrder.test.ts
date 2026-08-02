import { describe, expect, it } from 'vitest';
import { defaultGlickoSettings } from '@smashclub/shared';
import { compareSetsInBracket } from '../src/setOrder';
import { runWhrModel } from '../src/whrRun';
import { replayRatings } from '../src/replay';
import type { EngineSet, EngineTournament } from '../src/types';

/**
 * One bracket's sets must come out in the order they were played, and every
 * consumer must agree on what that order is. Before this, three places
 * disagreed and the WHR path was ordering a bracket by random uuid.
 */

const settings = defaultGlickoSettings;

const base = {
  id: 'x',
  suggestedPlayOrder: null as number | null,
  completedAt: null as string | null,
  challongeMatchId: null as number | null,
};

describe('compareSetsInBracket', () => {
  it('orders by the play-order hint first', () => {
    const a = { ...base, id: 'zzz', suggestedPlayOrder: 1 };
    const b = { ...base, id: 'aaa', suggestedPlayOrder: 2 };
    expect(compareSetsInBracket(a, b)).toBeLessThan(0);
  });

  it('falls back to completedAt when the hint is absent on both', () => {
    const a = { ...base, id: 'zzz', completedAt: '2025-01-01T10:00:00.000Z' };
    const b = { ...base, id: 'aaa', completedAt: '2025-01-01T11:00:00.000Z' };
    expect(compareSetsInBracket(a, b)).toBeLessThan(0);
  });

  it('falls back to the challonge match id, then the uuid', () => {
    const a = { ...base, id: 'zzz', challongeMatchId: 1 };
    const b = { ...base, id: 'aaa', challongeMatchId: 2 };
    expect(compareSetsInBracket(a, b)).toBeLessThan(0);

    const c = { ...base, id: 'aaa' };
    const d = { ...base, id: 'zzz' };
    expect(compareSetsInBracket(c, d)).toBeLessThan(0);
  });

  it('sorts a set missing a key after one that has it, at every level', () => {
    const withOrder = { ...base, id: 'zzz', suggestedPlayOrder: 99 };
    const without = { ...base, id: 'aaa', completedAt: '2025-01-01T00:00:00.000Z' };
    // Not the `?? 0` the WHR path used, which sent the null to the front.
    expect(compareSetsInBracket(withOrder, without)).toBeLessThan(0);

    const timed = { ...base, id: 'zzz', completedAt: '2025-01-01T00:00:00.000Z' };
    const untimed = { ...base, id: 'aaa', challongeMatchId: 1 };
    expect(compareSetsInBracket(timed, untimed)).toBeLessThan(0);
  });

  it('is a total order — no pair compares equal unless it is the same set', () => {
    const sets = [
      { ...base, id: 'a', suggestedPlayOrder: 1 },
      { ...base, id: 'b', suggestedPlayOrder: 1, completedAt: '2025-01-01T00:00:00.000Z' },
      { ...base, id: 'c' },
      { ...base, id: 'd', challongeMatchId: 7 },
    ];
    for (const x of sets) {
      for (const y of sets) {
        if (x.id === y.id) expect(compareSetsInBracket(x, y)).toBe(0);
        else expect(compareSetsInBracket(x, y)).not.toBe(0);
      }
    }
  });
});

/**
 * A double-elimination bracket as the club's data actually arrives: the play
 * order interleaves the winners and losers sides, the uuids are unrelated to
 * it, and some sets carry no timestamp at all.
 */
function doubleElim(): { tournaments: EngineTournament[]; sets: EngineSet[] } {
  //            play order:  1    2    3    4    5    6
  //                        WR1  WR1  LR1  WR2  LR2  GF
  const plan: [number, string, string, 1 | 2, string | null][] = [
    [1, 'alice', 'bob', 1, '2025-01-10T10:00:00.000Z'],
    [2, 'carol', 'dave', 1, '2025-01-10T10:05:00.000Z'],
    [3, 'bob', 'dave', 1, null], // losers round, never timestamped
    [4, 'alice', 'carol', 1, '2025-01-10T10:30:00.000Z'],
    [5, 'bob', 'carol', 2, '2025-01-10T10:45:00.000Z'],
    [6, 'alice', 'carol', 1, null], // grand final, never timestamped
  ];
  return {
    tournaments: [{ id: 't1', eventDate: '2025-01-10T18:00:00.000Z', isRookie: false, challongeId: 1 }],
    sets: plan.map(([order, p1, p2, winner, completedAt]) => ({
      // Deliberately reverse-correlated with play order, so any path that falls
      // through to the uuid produces exactly the wrong answer.
      id: `set-${String(100 - order).padStart(3, '0')}`,
      tournamentId: 't1',
      p1PlayerId: p1,
      p2PlayerId: p2,
      winner,
      suggestedPlayOrder: order,
      completedAt,
      challongeMatchId: order,
    })),
  };
}

describe('a bracket comes out in play order', () => {
  it('WHR emits each player their sets in the order they were played', () => {
    const { tournaments, sets } = doubleElim();
    const { events } = runWhrModel({ sets, tournaments, settings });

    const alice = events.filter((e) => e.playerId === 'alice').sort((a, b) => a.seq - b.seq);
    expect(alice.map((e) => e.setId)).toEqual(['set-099', 'set-096', 'set-094']);
  });

  it('WHR and the Glicko replay agree on the order of a bracket', () => {
    const { tournaments, sets } = doubleElim();
    const whr = runWhrModel({ sets, tournaments, settings });
    const glicko = replayRatings({ sets, tournaments, settings });

    const orderOf = (events: { playerId: string; setId: string | null; seq: number; isDecay: boolean }[]) =>
      events
        .filter((e) => !e.isDecay && e.playerId === 'carol')
        .sort((a, b) => a.seq - b.seq)
        .map((e) => e.setId);

    expect(orderOf(whr.events)).toEqual(orderOf(glicko.events));
  });

  it('shuffling the input array does not change the order sets are processed in', () => {
    const { tournaments, sets } = doubleElim();
    const reversed = [...sets].reverse();

    const straight = runWhrModel({ sets, tournaments, settings });
    const shuffled = runWhrModel({ sets: reversed, tournaments, settings });

    const seqOf = (events: { playerId: string; setId: string | null; seq: number }[]) =>
      events.filter((e) => e.playerId === 'alice').map((e) => `${e.seq}:${e.setId}`);

    expect(seqOf(shuffled.events)).toEqual(seqOf(straight.events));
  });

  /**
   * Production's actual state before the extractor was fixed: the default sync
   * source carries no `suggested_play_order`, so every set had a null one and
   * the only real signal left was `completedAt`. The WHR path ignored it and
   * fell through to the uuid, which is what shuffled a player's match history.
   */
  it('orders on completedAt when no set carries a play order at all', () => {
    const { tournaments, sets } = doubleElim();
    const unhinted = sets.map((s) => ({ ...s, suggestedPlayOrder: null, challongeMatchId: null }));
    const { events } = runWhrModel({ sets: unhinted, tournaments, settings });

    // alice: set-099 @10:00, set-096 @10:30, set-094 untimed (the grand final).
    // Ordering on the uuid would invert the first two.
    const alice = events.filter((e) => e.playerId === 'alice').sort((a, b) => a.seq - b.seq);
    expect(alice.map((e) => e.setId)).toEqual(['set-099', 'set-096', 'set-094']);
  });

  it('keeps a set with no timestamp in its bracket position rather than at an end', () => {
    const { tournaments, sets } = doubleElim();
    const { events } = runWhrModel({ sets, tournaments, settings });

    // set-097 (the untimed losers round) is bob's second set, not his first or
    // last: `?? 0` would have pulled it to the front, nulls-last to the back.
    const bob = events.filter((e) => e.playerId === 'bob').sort((a, b) => a.seq - b.seq);
    expect(bob.map((e) => e.setId)).toEqual(['set-099', 'set-097', 'set-095']);
  });
});
