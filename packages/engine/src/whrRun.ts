import type { GlickoSettings } from '@smashclub/shared';
import { attendanceOf, eventKeyOf } from './events';
import { fitWhr } from './whr';
import { activityPenaltyFor, rankScores, type LeaderboardRow, type PlayerScore } from './score';
import type { EngineSet, EngineTournament, RatingEvent } from './types';

/**
 * Runs Whole-History Rating over the full set history and returns the same
 * shape the Glicko-2 replay does, so the recompute pipeline can produce either
 * model without branching on anything but this call.
 *
 * Two structural differences from the Glicko path, both deliberate:
 *
 *  - **A rating period is one event, not one bracket.** Main and rookie brackets
 *    on the same evening are one period (see `eventKeyOf`), because they are one
 *    occasion and a player's skill did not change between them.
 *  - **Movement is booked per period, not per set.** WHR fits every rating from
 *    all evidence at once; it does not attribute a share of the change to an
 *    individual result, and pretending otherwise would invent numbers. So the
 *    first set a player plays in a period carries that period's whole rating
 *    change, and their remaining sets in it carry zero. Summed over a period the
 *    movement is exact, and the trajectory chart steps at period boundaries —
 *    which is what the model actually says.
 *
 * The uncertainty machinery the Glicko path needs (rookie RD inflation, the
 * isolation factor, the rating anchor, sample-confidence shrinkage) is absent
 * here on purpose: WHR already answers "how sure are we" with the posterior
 * variance, so `skillSd` is that variance directly rather than a stack of
 * hand-tuned multipliers. Those fields are still reported, because they describe
 * the *sample* rather than the model and the admin comparison view comes out
 * legible when both models populate the same columns.
 */
export interface WhrRunResult {
  events: RatingEvent[];
  leaderboard: LeaderboardRow[];
  converged: boolean;
  iterations: number;
  /** Distinct events (occasions) the fit ran over. */
  periods: number;
}

const MS_PER_DAY = 86_400_000;

interface Participation {
  playerId: string;
  matchCount: number;
  wins: number;
  losses: number;
  mainMatchCount: number;
  rookieMatchCount: number;
  tournamentIds: Set<string>;
  eventKeys: Set<string>;
  opponentIds: Set<string>;
  lastPlayedDate: string;
}

export function runWhrModel(input: {
  sets: readonly EngineSet[];
  tournaments: readonly EngineTournament[];
  settings: GlickoSettings;
}): WhrRunResult {
  const { settings } = input;
  const tournamentById = new Map(input.tournaments.map((t) => [t.id, t]));

  // Rateable sets only, in the same deterministic chronological order the
  // Glicko replay uses, so the two models see identical input.
  const rateable = input.sets
    .filter((set) => tournamentById.has(set.tournamentId) && set.p1PlayerId !== set.p2PlayerId)
    .map((set) => {
      const tournament = tournamentById.get(set.tournamentId)!;
      return {
        set,
        tournament,
        /** Which occasion this set belongs to — the rating period. */
        eventKey: eventKeyOf(tournament.eventDate),
        /**
         * Elapsed days, for the drift-variance axis only. Unlike the period, this
         * one really is time: uncertainty grows with the gap between occasions.
         */
        day: Math.floor(Date.parse(tournament.eventDate) / MS_PER_DAY),
      };
    })
    .sort(
      (a, b) =>
        a.day - b.day ||
        (a.tournament.eventDate < b.tournament.eventDate ? -1 : a.tournament.eventDate > b.tournament.eventDate ? 1 : 0) ||
        a.tournament.id.localeCompare(b.tournament.id) ||
        (a.set.suggestedPlayOrder ?? 0) - (b.set.suggestedPlayOrder ?? 0) ||
        a.set.id.localeCompare(b.set.id),
    );

  if (rateable.length === 0) {
    return { events: [], leaderboard: [], converged: true, iterations: 0, periods: 0 };
  }

  const originDay = rateable[0]!.day;
  const fit = fitWhr({
    sets: rateable.map(({ set, day }) => ({
      p1PlayerId: set.p1PlayerId,
      p2PlayerId: set.p2PlayerId,
      winner: set.winner,
      time: day - originDay,
    })),
    config: {
      driftVariancePerDay: settings.whrDriftVariancePerDay,
      priorSd: settings.whrPriorSd,
    },
  });

  // ---- participation counts (model-independent) ----
  const participation = new Map<string, Participation>();
  const ensure = (playerId: string, eventDate: string): Participation => {
    let row = participation.get(playerId);
    if (!row) {
      row = {
        playerId,
        matchCount: 0,
        wins: 0,
        losses: 0,
        mainMatchCount: 0,
        rookieMatchCount: 0,
        tournamentIds: new Set(),
        eventKeys: new Set(),
        opponentIds: new Set(),
        lastPlayedDate: eventDate,
      };
      participation.set(playerId, row);
    }
    if (eventDate > row.lastPlayedDate) row.lastPlayedDate = eventDate;
    return row;
  };

  for (const { set, tournament, eventKey } of rateable) {
    const p1 = ensure(set.p1PlayerId, tournament.eventDate);
    const p2 = ensure(set.p2PlayerId, tournament.eventDate);
    for (const [self, other] of [
      [p1, p2],
      [p2, p1],
    ] as const) {
      self.matchCount += 1;
      self.tournamentIds.add(tournament.id);
      self.eventKeys.add(eventKey);
      self.opponentIds.add(other.playerId);
      if (tournament.isRookie) self.rookieMatchCount += 1;
      else self.mainMatchCount += 1;
    }
    if (set.winner === 1) {
      p1.wins += 1;
      p2.losses += 1;
    } else {
      p2.wins += 1;
      p1.losses += 1;
    }
  }

  // ---- rating events ----
  // Walk the sets in order, booking each player's period movement on their first
  // set of that period.
  const events: RatingEvent[] = [];
  const seqByPlayer = new Map<string, number>();
  const lastPeriodRating = new Map<string, { rating: number; sd: number }>();
  const bookedPeriod = new Map<string, string>();

  for (const { set, tournament, day, eventKey } of rateable) {
    const time = day - originDay;
    for (const [playerId, opponentId, won] of [
      [set.p1PlayerId, set.p2PlayerId, set.winner === 1],
      [set.p2PlayerId, set.p1PlayerId, set.winner === 2],
    ] as const) {
      const current = fit.display(playerId, time);
      const previous = lastPeriodRating.get(playerId) ?? {
        rating: settings.initialRating,
        sd: settings.initialRd,
      };
      const firstOfPeriod = bookedPeriod.get(playerId) !== eventKey;

      const seq = (seqByPlayer.get(playerId) ?? 0) + 1;
      seqByPlayer.set(playerId, seq);

      events.push({
        playerId,
        seq,
        setId: set.id,
        tournamentId: tournament.id,
        isDecay: false,
        won,
        opponentId,
        preRating: firstOfPeriod ? previous.rating : current.rating,
        postRating: current.rating,
        preRd: firstOfPeriod ? previous.sd : current.sd,
        postRd: current.sd,
        // WHR has no volatility parameter; the posterior variance carries it.
        preVol: 0,
        postVol: 0,
        // Every result contributes equally to the joint fit.
        weight: 1,
      });

      if (firstOfPeriod) {
        bookedPeriod.set(playerId, eventKey);
        lastPeriodRating.set(playerId, current);
      }
    }
  }

  // ---- leaderboard ----
  /*
   * The activity penalty is club policy, not model output, so it is computed the
   * same way here as in the Glicko replay: from the club's event list and who
   * turned up to what. Switching the active model must not change what missing a
   * club night costs.
   */
  const orderedEventKeys = [...new Set(rateable.map((r) => r.eventKey))];

  const scores: PlayerScore[] = [];
  for (const row of participation.values()) {
    const latest = fit.display(row.playerId);
    let bridgeOpponentCount = 0;
    for (const opponentId of row.opponentIds) {
      if ((participation.get(opponentId)?.mainMatchCount ?? 0) > 0) bridgeOpponentCount += 1;
    }
    const rookieRatio = row.matchCount ? row.rookieMatchCount / row.matchCount : 0;
    const attendance = attendanceOf(orderedEventKeys, row.eventKeys);
    const activityPenalty = activityPenaltyFor(attendance.missedEvents, settings);
    scores.push({
      playerId: row.playerId,
      ...attendance,
      activityPenalty,
      nextMissPenalty: activityPenaltyFor(attendance.missedEvents + 1, settings) - activityPenalty,
      clubRating: latest.rating - activityPenalty,
      isProvisional:
        row.eventKeys.size < settings.provisionalEventCount || row.matchCount < settings.provisionalMatchCount,
      rating: latest.rating,
      rd: latest.sd,
      vol: 0,
      effectiveRating: latest.rating,
      effectiveRd: latest.sd,
      skillRating: latest.rating,
      skillSd: latest.sd,
      conservativeRating: latest.rating - 2 * latest.sd,
      matchCount: row.matchCount,
      wins: row.wins,
      losses: row.losses,
      mainMatchCount: row.mainMatchCount,
      rookieMatchCount: row.rookieMatchCount,
      tournamentCount: row.tournamentIds.size,
      eventCount: row.eventKeys.size,
      uniqueOpponentCount: row.opponentIds.size,
      bridgeOpponentCount,
      rookieRatio,
      // No isolation correction is applied — thin cross-bracket linkage already
      // shows up as a wider posterior.
      isolationFactor: 0,
      /**
       * Reported as a readable proxy for how much the posterior has tightened
       * relative to the prior, so the UI's confidence meter still means
       * something under this model.
       */
      sampleConfidence: Math.max(0, Math.min(1, 1 - latest.sd / settings.initialRd)),
      lastPlayedDate: row.lastPlayedDate,
    });
  }

  // Ranked exactly as the Glicko-2 board is, so switching the active model is a
  // change of model and not a change of what "first" means.
  const leaderboard = rankScores(scores, settings);

  const periods = new Set(rateable.map((r) => r.eventKey)).size;
  return { events, leaderboard, converged: fit.converged, iterations: fit.iterations, periods };
}
