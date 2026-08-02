import type { GlickoSettings } from '@smashclub/shared';
import { attendanceOf, eventKeyOf } from './events';
import { DISPLAY_CENTRE, NATURAL_TO_DISPLAY, fitWhr, type WhrFit } from './whr';
import { compareNullableNumbers, compareSetsInBracket, compareStrings } from './setOrder';
import { activityPenaltyFor, rankScores, type LeaderboardRow, type PlayerScore } from './score';
import type { EngineSet, EngineTournament, RatingEvent } from './types';

/**
 * Runs Whole-History Rating over the full set history and returns the same
 * shape the Glicko-2 replay does, so the recompute pipeline can produce either
 * model without branching on anything but this call.
 *
 * WHR is a batch fit: it re-estimates every rating from all evidence at once,
 * and a new night's results legitimately *revise* what the model believes
 * about the past. That is its strength on a small dataset — and a problem for
 * an app built around "what did this set do to my rating", where numbers that
 * silently rewrite themselves read as bugs. The run therefore keeps two books:
 *
 *  - **The ledger** (`pre`/`post` on each event): what the board published as
 *    of each night, computed by fitting only the history up to and including
 *    that night. Deltas booked this way are frozen — replaying history with
 *    more nights appended never changes an old row — so the match log is an
 *    append-only record of published movement, exactly as members experienced
 *    it. A night's total movement is attributed across that night's sets in
 *    proportion to how *surprising* each result was (win probability from the
 *    pre-night fit, weighted by set decisiveness), so a routine win carries a
 *    small share and an upset a large one, and the shares sum exactly to the
 *    night's move.
 *  - **The hindsight track** (`revisedRating`/`revisedSd`): the current full
 *    fit's estimate at each of the player's nights. This is where revision
 *    lives, visibly, instead of leaking into the ledger.
 *
 * Two structural differences from the Glicko path remain deliberate:
 *
 *  - **A rating period is one event, not one bracket.** Main and rookie
 *    brackets on the same evening are one occasion (see `eventKeyOf`), and a
 *    player's skill did not change between them.
 *  - **No decay events.** Time out of the game widens the posterior inside the
 *    model (Brownian drift), and the leaderboard evaluates everyone at the
 *    club's latest event so that widening actually reaches the published
 *    uncertainty, the conservative seeding score and the confidence meter.
 *    What absence costs on the *board* stays the explicit activity penalty,
 *    shared with the Glicko path — club policy, not model output.
 *
 * Most of the uncertainty machinery the Glicko path needs (rookie RD
 * inflation, sample-confidence shrinkage) is absent here on purpose: WHR
 * already answers "how sure are we" with the posterior variance, so `skillSd`
 * is that variance directly rather than a stack of hand-tuned multipliers.
 * The one exception is *bias*, which variance cannot express: a rookie
 * islander's point estimate is identified mostly by other islanders, so the
 * board can optionally shrink the displayed number by bridge exposure
 * (`whrIsolationAnchor`) and start rookie debuts from a calibrated prior
 * (`whrRookieDebutPrior`).
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

/**
 * Per-player plan for one night: the attributed per-set deltas, in the order
 * the player's sets occur, plus the ledger values the rows interpolate
 * between. Built night-by-night, consumed by the global chronological walk
 * that emits `RatingEvent` rows.
 */
interface NightPlan {
  deltas: number[];
  endRating: number;
  preSd: number;
  postSd: number;
  revisedRating: number;
  revisedSd: number;
  /** Next delta to consume during the emit walk. */
  cursor: number;
  /** Running ledger rating during the emit walk. */
  running: number;
}

export function runWhrModel(input: {
  sets: readonly EngineSet[];
  tournaments: readonly EngineTournament[];
  settings: GlickoSettings;
}): WhrRunResult {
  const { settings } = input;
  const tournamentById = new Map(input.tournaments.map((t) => [t.id, t]));
  const priorDisplaySd = settings.whrPriorSd * NATURAL_TO_DISPLAY;

  /**
   * A decisive set carries more evidence: `1 + weight·(margin − 1)` trials,
   * capped at 2, so a 3-0 counts as up to two independent results and a 3-2 —
   * or a set with no usable scoreline — as exactly one. The winner having
   * fewer games than the loser (a DQ artefact) reads as unknown.
   */
  const trialsOf = (set: EngineSet): number => {
    const winnerGames = set.winner === 1 ? set.p1Games : set.p2Games;
    const loserGames = set.winner === 1 ? set.p2Games : set.p1Games;
    if (winnerGames == null || loserGames == null || loserGames < 0 || winnerGames <= loserGames) return 1;
    return Math.max(1, Math.min(2, 1 + settings.whrGamesWeight * (winnerGames - loserGames - 1)));
  };

  // Rateable sets only, in the same deterministic chronological order the
  // Glicko replay uses, so the two models see identical input: brackets by
  // (eventDate, challongeId, id), then `compareSetsInBracket` within one.
  //
  // This once claimed that and did something else — it coalesced a missing play
  // order to 0 and then fell straight through to the set's random uuid, with no
  // `completedAt` tie-break at all. Since the default sync source left the play
  // order null on every set, a bracket's sets were ordered by uuid, i.e.
  // shuffled. The fit itself is unaffected (it is joint, and `time` is
  // per-bracket, so it sees the same multiset either way), but `seq` and the
  // choice of which set carries a period's movement are not — a player's match
  // history came out in a random order.
  const rateable: RateableSet[] = input.sets
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
    return { events: [], leaderboard: [], converged: true, iterations: 0, periods: 0, previousRanks: new Map() };
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
  const rookieDebutPriorNatural = (settings.whrRookieDebutPrior - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY;
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

  // ---- attribution plans, night by night ----
  const plans = new Map<string, Map<string, NightPlan>>(); // eventKey -> playerId -> plan
  const ledger = new Map<string, { rating: number; sd: number }>();

  for (const [eventIndex, eventKey] of orderedEventKeys.entries()) {
    const nightSets = rateable.filter((r) => r.eventKey === eventKey);
    const day = nightSets[0]!.day;
    const time = day - originDay;
    const nightFit = fits[eventIndex]!;
    const preFit = eventIndex > 0 ? fits[eventIndex - 1]! : null;

    // The player's results tonight, in play order.
    const results = new Map<string, Array<{ opponentId: string; won: boolean; trials: number }>>();
    for (const { set, trials } of nightSets) {
      for (const [playerId, opponentId, won] of [
        [set.p1PlayerId, set.p2PlayerId, set.winner === 1],
        [set.p2PlayerId, set.p1PlayerId, set.winner === 2],
      ] as const) {
        const list = results.get(playerId) ?? [];
        list.push({ opponentId, won, trials });
        results.set(playerId, list);
      }
    }

    const nightPlans = new Map<string, NightPlan>();
    for (const [playerId, played] of results) {
      const current = nightFit.display(playerId, time);
      const previous = ledger.get(playerId) ?? { rating: settings.initialRating, sd: priorDisplaySd };
      const nightDelta = current.rating - previous.rating;

      /**
       * Attribute the night's movement across its sets by surprise. The
       * first-order estimate of what one result does to a MAP fit is
       * `posterior variance × (outcome − expected)` in natural units — the
       * same quantity that drives the Newton step — with `expected` taken
       * from the *pre-night* fit, i.e. what the board would have predicted
       * before the set was played. What that linearisation cannot see
       * (opponents' own movement tonight, prior shrinkage on a debut) is
       * spread evenly as a remainder, so the shares always sum to exactly
       * the night's published movement.
       */
      const varianceNatural = (current.sd / NATURAL_TO_DISPLAY) ** 2;
      const residuals = played.map(({ opponentId, won, trials }) => {
        const expected = preFit ? preFit.winProbability(playerId, opponentId, time) : 0.5;
        return trials * ((won ? 1 : 0) - expected);
      });
      const base = residuals.map((residual) => varianceNatural * residual * NATURAL_TO_DISPLAY);
      const remainder = (nightDelta - base.reduce((sum, value) => sum + value, 0)) / played.length;

      const revised = fullFit.display(playerId, time);
      nightPlans.set(playerId, {
        deltas: base.map((value) => value + remainder),
        endRating: current.rating,
        preSd: previous.sd,
        postSd: current.sd,
        revisedRating: revised.rating,
        revisedSd: revised.sd,
        cursor: 0,
        running: previous.rating,
      });
      ledger.set(playerId, current);
    }
    plans.set(eventKey, nightPlans);
  }

  // ---- rating events: the global chronological walk ----
  const events: RatingEvent[] = [];
  const seqByPlayer = new Map<string, number>();

  for (const { set, tournament, eventKey, trials } of rateable) {
    for (const [playerId, opponentId, won] of [
      [set.p1PlayerId, set.p2PlayerId, set.winner === 1],
      [set.p2PlayerId, set.p1PlayerId, set.winner === 2],
    ] as const) {
      const plan = plans.get(eventKey)!.get(playerId)!;
      const index = plan.cursor;
      plan.cursor += 1;
      const isLastOfNight = plan.cursor === plan.deltas.length;
      const preRating = plan.running;
      // The last set lands exactly on the fit's value, so the ledger chains
      // float-exactly from night to night.
      const postRating = isLastOfNight ? plan.endRating : preRating + plan.deltas[index]!;
      plan.running = postRating;

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
        preRating,
        postRating,
        preRd: index === 0 ? plan.preSd : plan.postSd,
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
  settings: GlickoSettings,
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
   * the same way here as in the Glicko replay: from the club's event list and
   * who turned up to what. Switching the active model must not change what
   * missing a club night costs.
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
      const bridgeExposure = row.matchCount ? (bridgeMatchCounts.get(row.playerId) ?? 0) / row.matchCount : 0;
      isolationFactor = rookieRatio * (1 - Math.max(mainExperienceFactor, bridgeExposure));
      const anchorFactor = Math.max(0.25, 1 - 0.65 * isolationFactor);
      const priorDisplay = DISPLAY_CENTRE + (priorMeans.get(row.playerId) ?? 0) * NATURAL_TO_DISPLAY;
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
       * (not the Glicko initial RD, whose scale means nothing here). Zero for
       * a player we know nothing about, approaching one as evidence
       * accumulates — and falling again as an absence lets drift widen the
       * band, so the confidence meter stales honestly.
       */
      sampleConfidence: Math.max(0, Math.min(1, 1 - latest.sd / priorDisplaySd)),
      lastPlayedDate: row.lastPlayedDate,
    });
  }

  // Ranked exactly as the Glicko-2 board is, so switching the active model is a
  // change of model and not a change of what "first" means.
  return rankScores(scores, settings);
}
