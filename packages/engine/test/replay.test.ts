import { describe, expect, it } from 'vitest';
import { defaultGlickoSettings } from '@smashclub/shared';
import { GLICKO2_SCALE, updateRating } from '../src/glicko2';
import { replayRatings } from '../src/replay';
import type { EngineSet, EngineTournament } from '../src/types';

const settings = defaultGlickoSettings;

const tournament = (id: string, eventDate: string, isRookie = false, challongeId?: number): EngineTournament => ({
  id,
  eventDate,
  isRookie,
  challongeId: challongeId ?? null,
});

let setCounter = 0;
const makeSet = (
  tournamentId: string,
  p1: string,
  p2: string,
  winner: 1 | 2,
  extra: Partial<EngineSet> = {},
): EngineSet => ({
  id: `set-${++setCounter}`,
  tournamentId,
  p1PlayerId: p1,
  p2PlayerId: p2,
  winner,
  suggestedPlayOrder: setCounter,
  ...extra,
});

describe('replayRatings', () => {
  it('a single set matches a direct Glicko-2 update with full weight', () => {
    const t1 = tournament('t1', '2025-01-01');
    const set = makeSet('t1', 'alice', 'bob', 1);
    const { events, finalStates } = replayRatings({ sets: [set], tournaments: [t1], settings });

    const direct = updateRating(
      { rating: settings.initialRating, rd: settings.initialRd, vol: settings.initialVol },
      [{ rating: settings.initialRating, rd: settings.initialRd, outcome: 1 }],
      settings.tau,
    );
    const alice = finalStates.get('alice')!;
    expect(alice.rating).toBeCloseTo(direct.rating, 9);
    expect(alice.rd).toBeCloseTo(direct.rd, 9);
    expect(alice.vol).toBeCloseTo(direct.vol, 9);
    expect(alice.wins).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]!.weight).toBe(1);
  });

  it('applies the inverse-diminishing weight by lerping rating and RD but NOT volatility', () => {
    // Alice plays two sets in one tournament: first set weight (1/2)^0.3 < 1.
    const t1 = tournament('t1', '2025-01-01');
    const sets = [makeSet('t1', 'alice', 'bob', 1), makeSet('t1', 'alice', 'carol', 1)];
    const { events } = replayRatings({ sets, tournaments: [t1], settings });

    const firstAliceEvent = events.find((e) => e.playerId === 'alice' && !e.isDecay)!;
    const expectedWeight = (1 / 2) ** settings.inverseDiminishingExponent;
    expect(firstAliceEvent.weight).toBeCloseTo(expectedWeight, 12);

    const pre = { rating: settings.initialRating, rd: settings.initialRd, vol: settings.initialVol };
    const full = updateRating(pre, [{ rating: pre.rating, rd: pre.rd, outcome: 1 }], settings.tau);
    expect(firstAliceEvent.postRating).toBeCloseTo(pre.rating + (full.rating - pre.rating) * expectedWeight, 9);
    expect(firstAliceEvent.postRd).toBeCloseTo(pre.rd + (full.rd - pre.rd) * expectedWeight, 9);
    // Volatility keeps the full update (legacy behaviour, preserved deliberately).
    expect(firstAliceEvent.postVol).toBeCloseTo(full.vol, 12);

    // Bob's only set in the tournament gets full weight.
    const bobEvent = events.find((e) => e.playerId === 'bob')!;
    expect(bobEvent.weight).toBe(1);
  });

  it('scales rookie-bracket sets by the ACTUAL winner of the current set (legacy bug fix)', () => {
    // Both players start at 1500, which sits in the partial-penalty tier
    // (>= 1400): winner scale 0.375, loser scale 0.75.
    const t1 = tournament('t1', '2025-01-01', true);
    const set = makeSet('t1', 'alice', 'bob', 2);
    const { events } = replayRatings({ sets: [set], tournaments: [t1], settings });

    const alice = events.find((e) => e.playerId === 'alice')!;
    const bob = events.find((e) => e.playerId === 'bob')!;
    // Bob won: bob gets the winner scale, alice the loser scale — regardless
    // of processing order (the legacy engine read the previous set's winner).
    expect(bob.weight).toBeCloseTo(0.375, 12);
    expect(alice.weight).toBeCloseTo(0.75, 12);
  });

  it('uses the base rookie scale below the partial threshold', () => {
    const low = { ...settings, rookiePartialPenaltyThreshold: 1600 };
    const t1 = tournament('t1', '2025-01-01', true);
    const set = makeSet('t1', 'alice', 'bob', 1);
    const { events } = replayRatings({ sets: [set], tournaments: [t1], settings: low });
    expect(events.find((e) => e.playerId === 'alice')!.weight).toBeCloseTo(low.rookieBracketBaseScale, 12);
  });

  it('applies inactivity decay for skipped tournaments with escalation and cap', () => {
    const tournaments = [
      tournament('t1', '2025-01-01'),
      tournament('t2', '2025-02-01'),
      tournament('t3', '2025-03-01'),
      tournament('t4', '2025-04-01'),
    ];
    // Alice plays t1 and t4 (misses t2, t3). Bob/carol/dave fill the middle.
    const sets = [
      makeSet('t1', 'alice', 'bob', 1),
      makeSet('t2', 'bob', 'carol', 1),
      makeSet('t3', 'bob', 'carol', 2),
      makeSet('t4', 'alice', 'bob', 1),
    ];
    const { events } = replayRatings({ sets, tournaments, settings });

    const aliceDecay = events.filter((e) => e.playerId === 'alice' && e.isDecay);
    expect(aliceDecay).toHaveLength(2);
    expect(aliceDecay[0]!.tournamentId).toBe('t2');
    expect(aliceDecay[1]!.tournamentId).toBe('t3');

    // First step: multiplier = scale * (1 + 0*esc)
    const preRd = aliceDecay[0]!.preRd;
    const vol = aliceDecay[0]!.preVol;
    const expectedFirst = Math.min(
      Math.sqrt((preRd / GLICKO2_SCALE) ** 2 + settings.missedTournamentRdScale * vol * vol) * GLICKO2_SCALE,
      settings.rdCap,
    );
    expect(aliceDecay[0]!.postRd).toBeCloseTo(expectedFirst, 9);

    // Second step escalates by 20% and chains from the first.
    const expectedSecond = Math.min(
      Math.sqrt(
        (aliceDecay[0]!.postRd / GLICKO2_SCALE) ** 2 +
          settings.missedTournamentRdScale * (1 + settings.missedTournamentEscalation) * vol * vol,
      ) * GLICKO2_SCALE,
      settings.rdCap,
    );
    expect(aliceDecay[1]!.postRd).toBeCloseTo(expectedSecond, 9);

    // Decay is reflected in the pre-RD of alice's t4 set.
    const aliceT4 = events.find((e) => e.playerId === 'alice' && e.tournamentId === 't4' && !e.isDecay)!;
    expect(aliceT4.preRd).toBeCloseTo(expectedSecond, 9);
  });

  it('applies trailing decay through the latest tournament to the FINAL state (legacy bug fix)', () => {
    const tournaments = [tournament('t1', '2025-01-01'), tournament('t2', '2025-02-01'), tournament('t3', '2025-03-01')];
    // Carol plays only t1, then goes dark for t2 and t3.
    const sets = [
      makeSet('t1', 'carol', 'bob', 1),
      makeSet('t2', 'bob', 'dave', 1),
      makeSet('t3', 'bob', 'dave', 2),
    ];
    const { events, finalStates } = replayRatings({ sets, tournaments, settings });

    const carolDecay = events.filter((e) => e.playerId === 'carol' && e.isDecay);
    expect(carolDecay).toHaveLength(2);
    expect(carolDecay.map((e) => e.tournamentId)).toEqual(['t2', 't3']);
    // The decayed RD is persisted — going dark costs seeding confidence.
    expect(finalStates.get('carol')!.rd).toBeCloseTo(carolDecay[1]!.postRd, 9);
    expect(finalStates.get('carol')!.rd).toBeGreaterThan(carolDecay[0]!.preRd);
  });

  it('orders tournaments chronologically regardless of input array order', () => {
    const tournaments = [tournament('late', '2025-03-01'), tournament('early', '2025-01-01')];
    const sets = [makeSet('late', 'alice', 'bob', 1), makeSet('early', 'alice', 'bob', 2)];
    const { events, tournamentSequences } = replayRatings({ sets, tournaments, settings });
    expect(tournamentSequences.get('early')).toBe(0);
    expect(tournamentSequences.get('late')).toBe(1);
    expect(events[0]!.tournamentId).toBe('early');
  });

  it('is invariant under permutation of the input arrays (order-dependence bug fix)', () => {
    const tournaments = [
      tournament('t1', '2025-01-01', false, 11),
      tournament('t2', '2025-02-01', true, 22),
      tournament('t3', '2025-03-01', false, 33),
    ];
    const sets: EngineSet[] = [];
    const players = ['p1', 'p2', 'p3', 'p4', 'p5'];
    let order = 0;
    for (const t of tournaments) {
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          sets.push(
            makeSet(t.id, players[i]!, players[j]!, ((i + j + order) % 2 === 0 ? 1 : 2) as 1 | 2, {
              suggestedPlayOrder: ++order,
            }),
          );
        }
      }
    }

    const baseline = replayRatings({ sets, tournaments, settings });

    // Deterministic pseudo-shuffle (no Math.random in tests either).
    const shuffled = [...sets];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7919 + 13) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const permuted = replayRatings({ sets: shuffled, tournaments: [...tournaments].reverse(), settings });

    expect(permuted.events).toEqual(baseline.events);
    for (const [playerId, state] of baseline.finalStates) {
      const other = permuted.finalStates.get(playerId)!;
      expect(other.rating).toBe(state.rating);
      expect(other.rd).toBe(state.rd);
      expect(other.vol).toBe(state.vol);
    }
  });

  it('does not count registered-but-setless tournaments as missed for decay', () => {
    const tournaments = [
      tournament('t1', '2025-01-01'),
      tournament('empty', '2025-01-15'),
      tournament('t2', '2025-02-01'),
    ];
    const sets = [makeSet('t1', 'alice', 'bob', 1), makeSet('t2', 'alice', 'bob', 1)];
    const { events } = replayRatings({ sets, tournaments, settings });
    expect(events.some((e) => e.isDecay)).toBe(false);
  });

  /*
   * The club runs a main and a rookie bracket on the same evening, as two
   * separate Challonge tournaments. Decay counts occasions a player could have
   * attended, so both brackets are one period.
   */
  describe('decay counts event days, not brackets', () => {
    /** One evening, two brackets; alice is main-only, kirby is rookie-only. */
    const sameDayBrackets = (): { tournaments: EngineTournament[]; sets: EngineSet[] } => ({
      tournaments: [
        tournament('main1', '2025-01-10T18:00:00.000Z', false, 1),
        tournament('rookie1', '2025-01-10T20:30:00.000Z', true, 2),
        tournament('main2', '2025-02-10T18:00:00.000Z', false, 3),
        tournament('rookie2', '2025-02-10T20:30:00.000Z', true, 4),
      ],
      sets: [
        makeSet('main1', 'alice', 'bob', 1),
        makeSet('rookie1', 'kirby', 'yoshi', 1),
        makeSet('main2', 'alice', 'bob', 1),
        makeSet('rookie2', 'kirby', 'yoshi', 1),
      ],
    });

    it('charges no decay to a main-only player who attended every evening', () => {
      const { tournaments, sets } = sameDayBrackets();
      const { events } = replayRatings({ sets, tournaments, settings });

      expect(events.filter((e) => e.playerId === 'alice' && e.isDecay)).toHaveLength(0);
      // Nor to the rookie-only player, for the main brackets they were never in.
      expect(events.filter((e) => e.playerId === 'kirby' && e.isDecay)).toHaveLength(0);
      expect(events.some((e) => e.isDecay)).toBe(false);
    });

    it('is the behaviour that changed: per-bracket counting charged both of them', () => {
      const { tournaments, sets } = sameDayBrackets();
      const { events } = replayRatings({
        sets,
        tournaments,
        settings,
        compat: { decayPerBracket: true },
      });

      // Alice is charged for both rookie brackets — one inline, one by trailing
      // decay — and kirby for the main bracket. None was ever open to them.
      const alice = events.filter((e) => e.playerId === 'alice' && e.isDecay);
      const kirby = events.filter((e) => e.playerId === 'kirby' && e.isDecay);
      expect(alice.map((e) => e.tournamentId)).toEqual(['rookie1', 'rookie2']);
      expect(kirby.map((e) => e.tournamentId)).toEqual(['main2']);
      // And it cost them real confidence on evenings they turned up to.
      expect(alice[0]!.postRd).toBeGreaterThan(alice[0]!.preRd);
    });

    it('still charges one step per genuinely missed evening', () => {
      const tournaments = [
        tournament('main1', '2025-01-10T18:00:00.000Z', false, 1),
        tournament('rookie1', '2025-01-10T20:30:00.000Z', true, 2),
        tournament('main2', '2025-02-10T18:00:00.000Z', false, 3),
        tournament('rookie2', '2025-02-10T20:30:00.000Z', true, 4),
        tournament('main3', '2025-03-10T18:00:00.000Z', false, 5),
      ];
      // Alice plays the first and last evening, missing the middle one entirely.
      const sets = [
        makeSet('main1', 'alice', 'bob', 1),
        makeSet('rookie1', 'kirby', 'yoshi', 1),
        makeSet('main2', 'bob', 'carol', 1),
        makeSet('rookie2', 'kirby', 'yoshi', 1),
        makeSet('main3', 'alice', 'bob', 1),
      ];
      const { events } = replayRatings({ sets, tournaments, settings });

      const aliceDecay = events.filter((e) => e.playerId === 'alice' && e.isDecay);
      // One missed evening, not two missed brackets.
      expect(aliceDecay).toHaveLength(1);
      // Attributed to a bracket from the evening that was missed.
      expect(['main2', 'rookie2']).toContain(aliceDecay[0]!.tournamentId);
      expect(aliceDecay[0]!.postRd).toBeGreaterThan(aliceDecay[0]!.preRd);
    });

    it('counts events attended separately from brackets entered', () => {
      const { tournaments, sets } = sameDayBrackets();
      // Falco crosses both brackets on the first evening; alice plays main only.
      sets.push(makeSet('rookie1', 'alice', 'kirby', 1));
      const { finalStates } = replayRatings({ sets, tournaments, settings });

      const alice = finalStates.get('alice')!;
      // Two brackets on the first evening plus the main on the second: three
      // brackets, but only two occasions.
      expect(alice.tournamentIds.size).toBe(3);
      expect(alice.eventKeys.size).toBe(2);
    });

    it('treats same-day brackets as one period regardless of their times', () => {
      const tournaments = [
        tournament('a', '2025-01-10T09:00:00.000Z', false, 1),
        tournament('b', '2025-01-10T23:59:00.000Z', true, 2),
      ];
      const sets = [makeSet('a', 'alice', 'bob', 1), makeSet('b', 'kirby', 'yoshi', 1)];
      const { decayPeriods } = replayRatings({ sets, tournaments, settings });
      expect(decayPeriods.get('a')).toBe(decayPeriods.get('b'));
    });

    it('trailing decay also counts evenings, so an absent regular loses one step per evening', () => {
      const tournaments = [
        tournament('main1', '2025-01-10T18:00:00.000Z', false, 1),
        tournament('rookie1', '2025-01-10T20:30:00.000Z', true, 2),
        tournament('main2', '2025-02-10T18:00:00.000Z', false, 3),
        tournament('rookie2', '2025-02-10T20:30:00.000Z', true, 4),
      ];
      // Alice stops after the first evening; bob keeps playing.
      const sets = [
        makeSet('main1', 'alice', 'bob', 1),
        makeSet('rookie1', 'kirby', 'yoshi', 1),
        makeSet('main2', 'bob', 'carol', 1),
        makeSet('rookie2', 'kirby', 'yoshi', 1),
      ];
      const { events } = replayRatings({ sets, tournaments, settings });

      // Two evenings exist; alice attended the first, so she decays for the
      // second only — one step, not the two brackets it contained.
      expect(events.filter((e) => e.playerId === 'alice' && e.isDecay)).toHaveLength(1);
    });
  });
});
