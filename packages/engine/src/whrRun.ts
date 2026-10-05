import type { RatingSettings } from '@smashclub/shared';
import { isPlayedSet } from './results';
import { attendanceOf, eventKeyOf } from './events';
import { DISPLAY_CENTRE, NATURAL_TO_DISPLAY, fitWhr, whrSetTrials, type WhrFit } from './whr';
import { compareNullableNumbers, compareSetsInBracket, compareStrings } from './setOrder';
import { activityPenaltyFor, rankScores, type LeaderboardRow, type PlayerScore } from './score';
import type { EngineSet, EngineTournament, RatingEvent } from './types';

/**
 * Full WHR fit plus prefix estimates at each club night. Main and rookie
 * brackets on one day share a period. Each played set retains result metadata,
 * but its pre/post columns repeat the night estimates: WHR has no sequential
 * per-match rating changes. Approximate result impact is tracked in #95–98.
 * Brownian drift, evidence weighting and board/seeding policies are unchanged.
 */
export interface WhrRunResult {
  events: RatingEvent[];
  leaderboard: LeaderboardRow[];
  converged: boolean;
  iterations: number;
  /** Distinct events (occasions) the fit ran over. */
  periods: number;
  /**
   * Rank each player held on the board fitted *without* the latest event —
   * the same prefix the ledger already computes — so the recompute can record
   * `previousRank` without running a second withheld fit.
   */
  previousRanks: Map<string, number>;
}

const MS_PER_DAY = 86_400_000;

interface RateableSet {
  set: EngineSet;
  tournament: EngineTournament;
  /** Which occasion this set belongs to — the rating period. */
  eventKey: string;
  /**
   * Elapsed days, for the drift-variance axis only. Unlike the period, this
   * one really is time: uncertainty grows with the gap between occasions.
   */
  day: number;
  /** How many independent results this set counts as (decisiveness). */
  trials: number;
}

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

interface NightPlan {
  preRating: number;
  endRating: number;
  preSd: number;
  postSd: number;
  revisedRating: number;
  revisedSd: number;
}

export function runWhrModel(input: {
  sets: readonly EngineSet[];
  tournaments: readonly EngineTournament[];
  settings: RatingSettings;
}): WhrRunResult {
  const { settings } = input;
  const tournamentById = new Map(input.tournaments.map((t) => [t.id, t]));
  /**
   * A decisive set carries more evidence: `1 + weight·(margin − 1)` trials,
   * capped at 2, so a 3-0 counts as up to two independent results and a 3-2 —
   * or a set with no usable scoreline — as exactly one. The winner having
   * fewer games than the loser (a DQ artefact) reads as unknown.
   */
  const trialsOf = (set: EngineSet): number => {
    return whrSetTrials(set, settings.whrGamesWeight);
  };

  // Deterministic result order affects presentation and sequence, not the fit.
  const rateable: RateableSet[] = input.sets
    .filter(isPlayedSet)
    .filter((set) => tournamentById.has(set.tournamentId) && set.p1PlayerId !== set.p2PlayerId)
    .map((set) => {
      const tournament = tournamentById.get(set.tournamentId)!;
      return {
        set,
        tournament,
        eventKey: eventKeyOf(tournament.eventDate),
        day: Math.floor(Date.parse(tournament.eventDate) / MS_PER_DAY),
        trials: trialsOf(set),
      };
    })
    .sort(
      (a, b) =>
        a.day - b.day ||
        compareStrings(a.tournament.eventDate, b.tournament.eventDate) ||
        compareNullableNumbers(a.tournament.challongeId, b.tournament.challongeId) ||
        compareStrings(a.tournament.id, b.tournament.id) ||
        compareSetsInBracket(a.set, b.set),
    );

  if (rateable.length === 0) {
    return {
      events: [],
      leaderboard: [],
      converged: true,
      iterations: 0,
      periods: 0,
      previousRanks: new Map(),
    };
  }

  const originDay = rateable[0]!.day;

  /*
   * A player who debuts in a rookie bracket gets the rookie prior rather than
   * the global one. The rookie pool is pinned to the display scale almost
   * entirely through these priors — cross-bracket sets are scarce — so a prior
   * that overstates the typical rookie-night newcomer inflates the whole
   * island, and with it anyone who farms it. A debut bracket is the same in
   * every history prefix that contains the player, so one map computed over
   * the full history serves every prefix fit.
   */
  const rookieDebutPriorNatural =
    (settings.whrRookieDebutPrior - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY;
  const priorMeans = new Map<string, number>();
  if (rookieDebutPriorNatural !== 0) {
    const seen = new Set<string>();
    for (const { set, tournament } of rateable) {
      for (const playerId of [set.p1PlayerId, set.p2PlayerId]) {
        if (seen.has(playerId)) continue;
        seen.add(playerId);
        if (tournament.isRookie) priorMeans.set(playerId, rookieDebutPriorNatural);
      }
    }
  }

  /**
   * One fit per history prefix: `fits[k]` sees events 0..k and nothing later.
   * This is what freezes the ledger — event k's numbers depend only on what
   * had happened by event k, so appending event k+1 cannot rewrite them. The
   * last prefix is the full fit, which prices the leaderboard and the
   * hindsight track. A dozen events over ~1,000 sets makes this a dozen small
   * fits, each linear per iteration — cheap enough to keep the property.
   */
  const orderedEventKeys = [...new Set(rateable.map((r) => r.eventKey))];
  const eventIndexByKey = new Map(orderedEventKeys.map((key, index) => [key, index]));
  const fitPrefix = (upToEventIndex: number): WhrFit =>
    fitWhr({
      sets: rateable
        .filter((r) => eventIndexByKey.get(r.eventKey)! <= upToEventIndex)
        .map(({ set, day, trials }) => ({
          p1PlayerId: set.p1PlayerId,
          p2PlayerId: set.p2PlayerId,
          winner: set.winner,
          time: day - originDay,
          trials,
        })),
      config: {
        driftVariancePerDay: settings.whrDriftVariancePerDay,
        priorSd: settings.whrPriorSd,
      },
      priorMeans,
    });
  const fits = orderedEventKeys.map((_, index) => fitPrefix(index));
  const fullFit = fits[fits.length - 1]!;

  // Estimates at the night boundary, repeated on each played set.
  const plans = new Map<string, Map<string, NightPlan>>();
  for (const [eventIndex, eventKey] of orderedEventKeys.entries()) {
    const nightSets = rateable.filter((r) => r.eventKey === eventKey);
    const time = nightSets[0]!.day - originDay;
    const nightFit = fits[eventIndex]!;
    const preFit = eventIndex > 0 ? fits[eventIndex - 1]! : null;
    const playerIds = new Set(nightSets.flatMap(({ set }) => [set.p1PlayerId, set.p2PlayerId]));
    const nightPlans = new Map<string, NightPlan>();
    for (const playerId of playerIds) {
      const current = nightFit.display(playerId, time);
      const previous = preFit?.track(playerId)
        ? preFit.display(playerId, time)
        : {
            rating: DISPLAY_CENTRE + (priorMeans.get(playerId) ?? 0) * NATURAL_TO_DISPLAY,
            sd: settings.whrPriorSd * NATURAL_TO_DISPLAY,
          };
      const revised = fullFit.display(playerId, time);
      nightPlans.set(playerId, {
        preRating: previous.rating,
        endRating: current.rating,
        preSd: previous.sd,
        postSd: current.sd,
        revisedRating: revised.rating,
        revisedSd: revised.sd,
      });
    }
    plans.set(eventKey, nightPlans);
  }

  // ---- rating events: the global chronological walk ----
  const events: RatingEvent[] = [];
  // One global result sequence preserves recap history ordering.
  let seq = 0;

  for (const { set, tournament, eventKey, trials } of rateable) {
    for (const [playerId, opponentId, won] of [
      [set.p1PlayerId, set.p2PlayerId, set.winner === 1],
      [set.p2PlayerId, set.p1PlayerId, set.winner === 2],
    ] as const) {
      const plan = plans.get(eventKey)!.get(playerId)!;

      events.push({
        playerId,
        seq: seq++,
        setId: set.id,
        tournamentId: tournament.id,
        isDecay: false,
        won,
        opponentId,
        preRating: plan.preRating,
        postRating: plan.endRating,
        preRd: plan.preSd,
        postRd: plan.postSd,
        // WHR has no volatility parameter; the posterior variance carries it.
        preVol: 0,
        postVol: 0,
        /** How many results this set counted as — decisive sets carry more. */
        weight: trials,
        revisedRating: plan.revisedRating,
        revisedSd: plan.revisedSd,
      });
    }
  }

  const leaderboard = buildLeaderboard(fullFit, rateable, orderedEventKeys, settings, priorMeans);

  /**
   * The board as it stood before the latest night: the second-to-last prefix,
   * scored the same way. This is what the ▲▼ column diffs against, and using
   * the prefix directly keeps it byte-identical with the ledger's idea of
   * "before" — no separate withheld refit that could drift.
   */
  const previousRanks = new Map<string, number>();
  if (orderedEventKeys.length > 1) {
    const withheldKey = orderedEventKeys[orderedEventKeys.length - 1]!;
    const previousRateable = rateable.filter((r) => r.eventKey !== withheldKey);
    const previousBoard = buildLeaderboard(
      fits[orderedEventKeys.length - 2]!,
      previousRateable,
      orderedEventKeys.slice(0, -1),
      settings,
      priorMeans,
    );
    for (const row of previousBoard) previousRanks.set(row.playerId, row.rank);
  }

  return {
    events,
    leaderboard,
    converged: fullFit.converged,
    iterations: fullFit.iterations,
    periods: orderedEventKeys.length,
    previousRanks,
  };
}

/**
 * Score and rank one fitted board. Everyone is evaluated *at the club's
 * latest event*, not at their own last appearance: for the absent, the fit
 * adds drift variance for the gap, so their uncertainty — and with it the
 * conservative seeding score — honestly widens while their point estimate
 * stays put. That is WHR's version of inactivity decay; the points docked on
 * the public board remain the explicit, model-independent activity penalty.
 */
function buildLeaderboard(
  fit: WhrFit,
  rateable: readonly RateableSet[],
  orderedEventKeys: readonly string[],
  settings: RatingSettings,
  /** Natural-units prior centres (rookie debuts); the isolation anchor's target. */
  priorMeans: ReadonlyMap<string, number>,
): LeaderboardRow[] {
  const priorDisplaySd = settings.whrPriorSd * NATURAL_TO_DISPLAY;
  const latestTime =
    rateable.length === 0 ? 0 : rateable[rateable.length - 1]!.day - rateable[0]!.day;

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

  /*
   * Matches played against someone with main-bracket experience, per player.
   * This is the *exposure* version of the bridge measure: a share of the
   * player's own matches, not a count of acquaintances. The old count-of-5
   * test declared an islander fully bridged after brushing past five such
   * players once each — trivially satisfied in brackets that mix veterans in —
   * while their record stayed 90% intra-island.
   */
  const bridgeMatchCounts = new Map<string, number>();
  for (const { set } of rateable) {
    for (const [selfId, otherId] of [
      [set.p1PlayerId, set.p2PlayerId],
      [set.p2PlayerId, set.p1PlayerId],
    ] as const) {
      if ((participation.get(otherId)?.mainMatchCount ?? 0) > 0) {
        bridgeMatchCounts.set(selfId, (bridgeMatchCounts.get(selfId) ?? 0) + 1);
      }
    }
  }

  /*
   * The activity penalty is club policy, not model output, so it is computed
   * the same way here as in the club policy: from the club's event list and
   * who turned up to what. Missing a club night has an explicit cost.
   */
  const scores: PlayerScore[] = [];
  for (const row of participation.values()) {
    const latest = fit.display(row.playerId, latestTime);
    let bridgeOpponentCount = 0;
    for (const opponentId of row.opponentIds) {
      if ((participation.get(opponentId)?.mainMatchCount ?? 0) > 0) bridgeOpponentCount += 1;
    }
    const rookieRatio = row.matchCount ? row.rookieMatchCount / row.matchCount : 0;
    const attendance = attendanceOf(orderedEventKeys, row.eventKeys);
    const activityPenalty = activityPenaltyFor(attendance.missedEvents, settings);

    /*
     * The posterior variance says how unsure the fit is, but the *point
     * estimate* of a rookie islander is identified mostly by other islanders,
     * and the board publishes the point estimate. When enabled, shrink the
     * displayed rating toward the player's own prior by how little of their
     * record touches the established field. The fit and win probabilities are
     * untouched.
     */
    let isolationFactor = 0;
    let displayedRating = latest.rating;
    if (settings.whrIsolationAnchor) {
      const mainExperienceFactor = Math.min(row.mainMatchCount, 5) / 5;
      const bridgeExposure = row.matchCount
        ? (bridgeMatchCounts.get(row.playerId) ?? 0) / row.matchCount
        : 0;
      isolationFactor = rookieRatio * (1 - Math.max(mainExperienceFactor, bridgeExposure));
      const anchorFactor = Math.max(0.25, 1 - 0.65 * isolationFactor);
      const priorDisplay =
        DISPLAY_CENTRE + (priorMeans.get(row.playerId) ?? 0) * NATURAL_TO_DISPLAY;
      displayedRating = priorDisplay + (latest.rating - priorDisplay) * anchorFactor;
    }

    scores.push({
      playerId: row.playerId,
      ...attendance,
      activityPenalty,
      nextMissPenalty: activityPenaltyFor(attendance.missedEvents + 1, settings) - activityPenalty,
      clubRating: displayedRating - activityPenalty,
      /*
       * A player with no main-bracket sets stays provisional however many
       * rookie nights they have played: their level against the field the
       * board ranks is exactly what the record has not established.
       */
      isProvisional:
        row.eventKeys.size < settings.provisionalEventCount ||
        row.matchCount < settings.provisionalMatchCount ||
        row.mainMatchCount === 0,
      rating: latest.rating,
      rd: latest.sd,
      vol: 0,
      effectiveRating: displayedRating,
      effectiveRd: latest.sd,
      skillRating: displayedRating,
      skillSd: latest.sd,
      conservativeRating: displayedRating - 2 * latest.sd,
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
      isolationFactor,
      /**
       * How much the posterior has tightened relative to *this model's* prior
       * Zero for
       * a player we know nothing about, approaching one as evidence
       * accumulates — and falling again as an absence lets drift widen the
       * band, so the confidence meter stales honestly.
       */
      sampleConfidence: Math.max(0, Math.min(1, 1 - latest.sd / priorDisplaySd)),
      lastPlayedDate: row.lastPlayedDate,
    });
  }

  return rankScores(scores, settings);
}
