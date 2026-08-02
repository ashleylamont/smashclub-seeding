import type { GlickoSettings } from '@smashclub/shared';
import { attendanceOf, eventKeyOf } from './events';
import { GLICKO2_SCALE, updateRating, type Rating } from './glicko2';
import {
  compareNullableNumbers,
  compareSetsInBracket,
  compareStrings,
} from './setOrder';
import type {
  EngineSet,
  EngineTournament,
  PlayerFinalState,
  RatingEvent,
  ReplayResult,
} from './types';

/**
 * Flags that reproduce specific defects of the legacy Python engine so the
 * port can be validated against its real recorded output. Each corresponds to
 * a bug fixed in the default (production) path.
 */
export interface LegacyCompat {
  /**
   * Replay sets in the caller-supplied array order and number tournaments by
   * order of first appearance, rather than sorting chronologically.
   */
  legacyOrdering?: boolean;
  /**
   * Reproduce the use-before-assign defect where rookie-bracket scaling read
   * the *previous* set's winner (glicko_calculator.py:285, assigned at :355).
   */
  rookieScaleUsesPreviousWinner?: boolean;
  /**
   * Reproduce trailing inactivity decay being computed for charts but never
   * written back to player state, so going dark did not affect seeding.
   */
  skipTrailingDecay?: boolean;
  /**
   * Count inactivity decay in missed *brackets* rather than missed events.
   *
   * The club runs a main and a rookie bracket on the same evening as two
   * separate Challonge tournaments. Counting per bracket means a main-only
   * regular is recorded as having "missed" every rookie bracket they were never
   * in — and vice versa — so RD grows on evenings they actually attended.
   */
  decayPerBracket?: boolean;
  /**
   * Grow RD per missed period by the legacy volatility-scaled, escalating rule
   * (`LEGACY_DECAY`) instead of the flat quadrature step.
   *
   * Only golden-check needs this. Mid-history decay feeds the pre-RD of every
   * later set, so without it the replay cannot reproduce the recorded output.
   */
  legacyVolatilityDecay?: boolean;
}

/**
 * The legacy decay constants, as the Python CLI hardcoded them.
 *
 * Historical facts rather than tunables — the compat path exists to reproduce a
 * fixed recorded output — so they live here instead of in settings, where they
 * would invite someone to tune a formula that production no longer runs.
 */
const LEGACY_DECAY = { rdScale: 20, escalation: 0.2 } as const;

/**
 * Replays the full set history through Glicko-2 and returns every rating
 * event plus final player states. Matches are the source of truth; everything
 * returned here is derived and recomputable.
 *
 * Ordering is deterministic and is itself a rating input (each set is its own
 * rating period): tournaments are ordered by (eventDate, challongeId, id) and
 * assigned a dense `sequence`; sets within a tournament are ordered by
 * (suggestedPlayOrder, completedAt, challongeMatchId, id), nulls last. The
 * legacy CLI processed sets in CSV file order, which made input order silently
 * change ratings — this replaces that.
 *
 * Faithfully ported legacy behaviour:
 * - Each set is its own rating period, updated symmetrically from both
 *   players' pre-set values.
 * - Per-tournament inverse-diminishing weight w = (matchNum/total)^exponent,
 *   applied by lerping rating and RD back toward their pre-update values.
 *   Volatility is intentionally left fully updated (legacy behaviour).
 * - Rookie-bracket scaling by the player's pre-set rating tier. (Legacy read
 *   the winner of the *previous* set due to a use-before-assign bug; here the
 *   actual winner of the current set is used.)
 * - Inactivity decay, counted in missed *events*, RD capped. Not elapsed time: a
 *   long gap between club nights costs one step, not one per day. Decay after a
 *   player's most recent event is applied through the final period and persisted
 *   into the final state (legacy computed it for charts but never applied it).
 *   Legacy counted a missed period per *bracket*, charging players for brackets
 *   they were never in, and escalated the step per consecutive miss — see
 *   `decayedRd` for why neither survives.
 */
export function replayRatings(input: {
  sets: readonly EngineSet[];
  tournaments: readonly EngineTournament[];
  settings: GlickoSettings;
  /**
   * Bug-for-bug reproduction of the legacy Python engine, used only by
   * tools/golden-check to prove this port is faithful before the fixes are
   * applied. Never set in production.
   */
  compat?: LegacyCompat;
}): ReplayResult {
  const { sets, tournaments, settings, compat } = input;

  const tournamentsById = new Map(tournaments.map((t) => [t.id, t]));
  for (const set of sets) {
    if (!tournamentsById.has(set.tournamentId)) {
      throw new Error(`Set ${set.id} references unknown tournament ${set.tournamentId}`);
    }
  }

  // Dense chronological tournament sequence. Only tournaments that actually
  // have rateable sets participate (a registered-but-empty tournament must
  // not count as "missed" for decay).
  //
  // Legacy ordering instead numbered tournaments by order of first appearance
  // in the input file and replayed sets in file order, which made input order
  // a rating input.
  const activeTournamentIds = new Set(sets.map((s) => s.tournamentId));
  const orderedTournaments = compat?.legacyOrdering
    ? dedupe(sets.map((s) => s.tournamentId)).map((id) => tournamentsById.get(id)!)
    : tournaments
        .filter((t) => activeTournamentIds.has(t.id))
        .sort(
          (a, b) =>
            compareStrings(a.eventDate, b.eventDate) ||
            compareNullableNumbers(a.challongeId, b.challongeId) ||
            compareStrings(a.id, b.id),
        );
  const tournamentSequences = new Map<string, number>();
  orderedTournaments.forEach((t, index) => tournamentSequences.set(t.id, index));

  /*
   * A decay period is one *event*, not one bracket.
   *
   * Decay counts occasions a player could have attended and did not. It is NOT
   * elapsed time: a three-month gap between club nights costs one step, not
   * ninety. `eventKeyOf` decides which brackets are the same occasion.
   *
   * Counting per bracket instead meant a main-only regular was charged a step for
   * every rookie bracket they were never eligible for, so their RD grew on
   * evenings they had actually turned up to — and the reverse for rookie-only
   * players.
   */
  const periodByTournament = new Map<string, number>();
  const tournamentIdByPeriod: string[] = [];
  if (compat?.decayPerBracket) {
    orderedTournaments.forEach((t, index) => {
      periodByTournament.set(t.id, index);
      tournamentIdByPeriod.push(t.id);
    });
  } else {
    const periodByEvent = new Map<string, number>();
    for (const tournament of orderedTournaments) {
      const key = eventKeyOf(tournament.eventDate);
      let period = periodByEvent.get(key);
      if (period === undefined) {
        period = periodByEvent.size;
        periodByEvent.set(key, period);
        // Decay events need a tournament to hang off; use the event's first bracket.
        tournamentIdByPeriod.push(tournament.id);
      }
      periodByTournament.set(tournament.id, period);
    }
  }

  const orderedSets = compat?.legacyOrdering
    ? [...sets]
    : [...sets].sort(
        (a, b) =>
          tournamentSequences.get(a.tournamentId)! - tournamentSequences.get(b.tournamentId)! ||
          compareSetsInBracket(a, b),
      );

  // First pass: total sets per player per tournament, for the
  // inverse-diminishing weight denominator.
  const totalsByPlayerTournament = new Map<string, number>();
  for (const set of orderedSets) {
    for (const playerId of [set.p1PlayerId, set.p2PlayerId]) {
      const key = `${playerId}\u0000${set.tournamentId}`;
      totalsByPlayerTournament.set(key, (totalsByPlayerTournament.get(key) ?? 0) + 1);
    }
  }

  interface InternalState {
    rating: Rating;
    matchCount: number;
    wins: number;
    losses: number;
    mainMatchCount: number;
    rookieMatchCount: number;
    /** Dense index of the last event played; drives decay counting. */
    lastPeriodIndex: number | null;
    lastPlayedDate: string | null;
    tournamentIds: Set<string>;
    /** Events (occasions) attended, as opposed to brackets entered. */
    eventKeys: Set<string>;
    opponentIds: Set<string>;
  }

  const states = new Map<string, InternalState>();
  const indicesByPlayerTournament = new Map<string, number>();
  const events: RatingEvent[] = [];
  let seq = 0;

  const getState = (playerId: string): InternalState => {
    let state = states.get(playerId);
    if (!state) {
      state = {
        rating: {
          rating: settings.initialRating,
          rd: settings.initialRd,
          vol: settings.initialVol,
        },
        matchCount: 0,
        wins: 0,
        losses: 0,
        mainMatchCount: 0,
        rookieMatchCount: 0,
        lastPeriodIndex: null,
        lastPlayedDate: null,
        tournamentIds: new Set(),
        eventKeys: new Set(),
        opponentIds: new Set(),
      };
      states.set(playerId, state);
    }
    return state;
  };

  /**
   * One missed-event decay step; returns the new (capped) RD.
   *
   * A flat growth term combined in quadrature, uniform across players and
   * across consecutive misses. What it replaced grew RD by ~20 idle Glicko
   * periods per missed event, escalating 20% per consecutive miss and scaled by
   * the player's own volatility — three compounding multipliers whose real job
   * was to make `skill − 2·RD` punish absence hard enough to notice. The board
   * now states that penalty outright, so RD is free to mean only what it says:
   * how sure we are. Two players who have been away the same number of events
   * now accrue the same doubt, and it stops at `decayRdCap` rather than climbing
   * to the cold-start value, because a lapsed regular is not a stranger.
   */
  const decayedRd = (rd: number, vol: number, missIndex: number): number => {
    const phi = rd / GLICKO2_SCALE;
    if (compat?.legacyVolatilityDecay) {
      const multiplier = LEGACY_DECAY.rdScale * (1 + missIndex * LEGACY_DECAY.escalation);
      return Math.min(Math.sqrt(phi * phi + multiplier * vol * vol) * GLICKO2_SCALE, settings.rdCap);
    }
    const grown = Math.sqrt(rd * rd + settings.missedEventRdGrowth * settings.missedEventRdGrowth);
    // Already past the ceiling (a newcomer decaying from 350) must not be
    // dragged *down* to it: decay may only ever widen a player's band.
    return Math.max(rd, Math.min(grown, settings.decayRdCap));
  };

  const applyDecay = (playerId: string, state: InternalState, targetPeriod: number): void => {
    if (state.lastPeriodIndex === null) return;
    const missed = targetPeriod - state.lastPeriodIndex - 1;
    for (let i = 0; i < missed; i++) {
      const missedPeriod = state.lastPeriodIndex + 1 + i;
      const preRd = state.rating.rd;
      const postRd = decayedRd(preRd, state.rating.vol, i);
      /*
       * Nothing to record when the step cannot widen the band any further —
       * someone we have seen once is already at the ceiling, and there is no
       * more doubt to add about a player we barely know. Emitting the event
       * anyway would put a run of zero-change decay marks on their chart and
       * invite the reader to look for a change that is not there.
       */
      if (postRd <= preRd) continue;
      state.rating = { ...state.rating, rd: postRd };
      events.push({
        seq: seq++,
        playerId,
        setId: null,
        tournamentId: tournamentIdByPeriod[missedPeriod]!,
        isDecay: true,
        won: null,
        opponentId: null,
        preRating: state.rating.rating,
        postRating: state.rating.rating,
        preRd,
        postRd,
        preVol: state.rating.vol,
        postVol: state.rating.vol,
        weight: 1,
      });
    }
  };

  const rookieScale = (rating: number, won: boolean): number => {
    if (rating >= settings.rookieOverPenaltyThreshold) return won ? 0.4 : 1.25;
    if (rating >= settings.rookieFullPenaltyThreshold) return won ? 0.25 : 1.0;
    if (rating >= settings.rookiePartialPenaltyThreshold) return won ? 0.375 : 0.75;
    return settings.rookieBracketBaseScale;
  };

  // Legacy read this from the previous loop iteration when scaling rookie
  // matches; only used under compat.
  let previousP1Won = false;

  for (const set of orderedSets) {
    const tournament = tournamentsById.get(set.tournamentId)!;
    const period = periodByTournament.get(set.tournamentId)!;
    const state1 = getState(set.p1PlayerId);
    const state2 = getState(set.p2PlayerId);
    const p1Won = set.winner === 1;
    const scaleWinnerFlag = compat?.rookieScaleUsesPreviousWinner ? previousP1Won : p1Won;
    previousP1Won = p1Won;

    // Inactivity decay for tournaments missed since each player's last event.
    applyDecay(set.p1PlayerId, state1, period);
    applyDecay(set.p2PlayerId, state2, period);

    // Inverse-diminishing weight from the set's position in the player's
    // tournament run (1-indexed; the last set gets full weight).
    const key1 = `${set.p1PlayerId}\u0000${set.tournamentId}`;
    const key2 = `${set.p2PlayerId}\u0000${set.tournamentId}`;
    const index1 = (indicesByPlayerTournament.get(key1) ?? 0) + 1;
    const index2 = (indicesByPlayerTournament.get(key2) ?? 0) + 1;
    indicesByPlayerTournament.set(key1, index1);
    indicesByPlayerTournament.set(key2, index2);
    let weight1 = (index1 / totalsByPlayerTournament.get(key1)!) ** settings.inverseDiminishingExponent;
    let weight2 = (index2 / totalsByPlayerTournament.get(key2)!) ** settings.inverseDiminishingExponent;

    if (tournament.isRookie) {
      weight1 *= rookieScale(state1.rating.rating, scaleWinnerFlag);
      weight2 *= rookieScale(state2.rating.rating, !scaleWinnerFlag);
    }

    // Symmetric update from both players' pre-set values.
    const pre1 = state1.rating;
    const pre2 = state2.rating;
    const updated1 = updateRating(pre1, [{ rating: pre2.rating, rd: pre2.rd, outcome: p1Won ? 1 : 0 }], settings.tau);
    const updated2 = updateRating(pre2, [{ rating: pre1.rating, rd: pre1.rd, outcome: p1Won ? 0 : 1 }], settings.tau);

    // Weight is applied by lerping rating and RD toward the pre-update
    // values; volatility keeps the full update (legacy behaviour).
    state1.rating = {
      rating: pre1.rating + (updated1.rating - pre1.rating) * weight1,
      rd: pre1.rd + (updated1.rd - pre1.rd) * weight1,
      vol: updated1.vol,
    };
    state2.rating = {
      rating: pre2.rating + (updated2.rating - pre2.rating) * weight2,
      rd: pre2.rd + (updated2.rd - pre2.rd) * weight2,
      vol: updated2.vol,
    };

    for (const [playerId, state, pre, weight, won, opponentId] of [
      [set.p1PlayerId, state1, pre1, weight1, p1Won, set.p2PlayerId],
      [set.p2PlayerId, state2, pre2, weight2, !p1Won, set.p1PlayerId],
    ] as const) {
      state.matchCount += 1;
      state.wins += won ? 1 : 0;
      state.losses += won ? 0 : 1;
      if (tournament.isRookie) {
        state.rookieMatchCount += 1;
      } else {
        state.mainMatchCount += 1;
      }
      state.lastPeriodIndex = period;
      state.lastPlayedDate = tournament.eventDate;
      state.tournamentIds.add(set.tournamentId);
      state.eventKeys.add(eventKeyOf(tournament.eventDate));
      state.opponentIds.add(opponentId);
      events.push({
        seq: seq++,
        playerId,
        setId: set.id,
        tournamentId: set.tournamentId,
        isDecay: false,
        won,
        opponentId,
        preRating: pre.rating,
        postRating: state.rating.rating,
        preRd: pre.rd,
        postRd: state.rating.rd,
        preVol: pre.vol,
        postVol: state.rating.vol,
        weight,
      });
    }
  }

  // Trailing decay: players who stopped playing keep accruing RD through the
  // most recent event, and it counts (persisted into final state).
  // Legacy computed these snapshots for charts but never wrote them back, so
  // going dark did not affect seeding.
  const lastPeriod = tournamentIdByPeriod.length - 1;
  if (lastPeriod >= 0 && !compat?.skipTrailingDecay) {
    for (const [playerId, state] of [...states.entries()].sort(([a], [b]) => compareStrings(a, b))) {
      applyDecay(playerId, state, lastPeriod + 1);
    }
  }

  /*
   * Attendance is derived from the club's event list, not from the decay
   * bookkeeping above, so it means the same thing under either rating model —
   * and stays correct under `decayPerBracket`, where the decay periods are
   * brackets and would answer "how many events have you missed" wrongly.
   *
   * Sorted explicitly rather than relying on tournament order, which under
   * `legacyOrdering` is input order and not chronological.
   */
  const orderedEventKeys = dedupe(orderedTournaments.map((t) => eventKeyOf(t.eventDate))).sort(compareStrings);

  const finalStates = new Map<string, PlayerFinalState>();
  for (const [playerId, state] of states) {
    finalStates.set(playerId, {
      playerId,
      ...attendanceOf(orderedEventKeys, state.eventKeys),
      rating: state.rating.rating,
      rd: state.rating.rd,
      vol: state.rating.vol,
      matchCount: state.matchCount,
      wins: state.wins,
      losses: state.losses,
      mainMatchCount: state.mainMatchCount,
      rookieMatchCount: state.rookieMatchCount,
      lastPeriodIndex: state.lastPeriodIndex!,
      lastPlayedDate: state.lastPlayedDate!,
      tournamentIds: state.tournamentIds,
      eventKeys: state.eventKeys,
      opponentIds: state.opponentIds,
    });
  }

  return { events, finalStates, tournamentSequences, decayPeriods: periodByTournament };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

