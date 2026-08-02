import { and, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { playerRatings, ratingEvents, recomputes, sets, tournaments } from '@smashclub/db';
import {
  calibrateLeagueBands,
  computeLeaderboard,
  eventKeyOf,
  parseScoresCsv,
  replayRatings,
  runWhrModel,
  type EngineSet,
  type EngineTournament,
  type LeaderboardRow,
  type RatingEvent,
} from '@smashclub/engine';
import { scoresIndicateUnplayed, type GlickoSettings } from '@smashclub/shared';
import { getGlickoSettings, updateGlickoSettings } from '../settings';

export const ENGINE_VERSION = '1.0.0';
const KEEP_RECOMPUTES = 5;
const EVENT_INSERT_CHUNK = 500;

/**
 * Full rating recompute: loads every rateable set (complete, both players
 * resolved, not excluded) from tournaments with a known event date, replays
 * them through the engine, and writes rating_events + player_ratings under a
 * new recompute row. Readers always query the latest complete recompute, so
 * a running recompute never disturbs them. Old recomputes are pruned.
 */
export async function runRecompute(
  db: Db,
): Promise<{ recomputeId: string; model: string; players: number; sets: number; events: number }> {
  const { glicko, version } = await getGlickoSettings(db);

  const tournamentRows = await db
    .select({
      id: tournaments.id,
      eventDate: tournaments.eventDate,
      isRookie: tournaments.isRookie,
      challongeId: tournaments.challongeId,
    })
    .from(tournaments)
    .where(isNotNull(tournaments.eventDate));

  const engineTournaments: EngineTournament[] = tournamentRows.map((row) => ({
    id: row.id,
    eventDate: row.eventDate!.toISOString(),
    isRookie: row.isRookie,
    challongeId: row.challongeId,
  }));
  const tournamentIds = engineTournaments.map((t) => t.id);

  const setRows = tournamentIds.length
    ? await db
        .select()
        .from(sets)
        .where(
          and(
            inArray(sets.tournamentId, tournamentIds),
            eq(sets.state, 'complete'),
            eq(sets.excludedFromRatings, false),
            isNotNull(sets.p1PlayerId),
            isNotNull(sets.p2PlayerId),
            isNotNull(sets.winner),
          ),
        )
    : [];

  const engineSets: EngineSet[] = setRows
    .filter((row) => row.p1PlayerId !== row.p2PlayerId)
    /*
     * A `99-0` is a bye — nobody played it, so it cannot move a rating, and it
     * must not reach the game-count weighting below as the most decisive set in
     * club history. The sync marks these excluded, but that is a stored verdict
     * on rows that may predate the rule; the scoreline is the evidence, so it
     * is re-read here and the ratings come out right on the next recompute
     * rather than on the next re-sync.
     */
    .filter((row) => !scoresIndicateUnplayed(row.scoresCsv))
    .map((row) => {
      // Game counts feed WHR's evidence weighting (a 3-0 outrates a 3-2);
      // forfeits and unreadable scorelines come back `unknown` and rate as a
      // plain set. The Glicko replay ignores these fields.
      const score = parseScoresCsv(row.scoresCsv);
      return {
        id: row.id,
        tournamentId: row.tournamentId,
        p1PlayerId: row.p1PlayerId!,
        p2PlayerId: row.p2PlayerId!,
        winner: row.winner as 1 | 2,
        suggestedPlayOrder: row.suggestedPlayOrder,
        completedAt: row.completedAt?.toISOString() ?? null,
        challongeMatchId: row.challongeMatchId,
        p1Games: score.unknown ? null : score.p1,
        p2Games: score.unknown ? null : score.p2,
      };
    });

  const model = glicko.activeModel;
  const [recompute] = await db
    .insert(recomputes)
    .values({
      engineVersion: ENGINE_VERSION,
      model,
      settingsSnapshot: { glicko, version } as unknown as Record<string, unknown>,
    })
    .returning({ id: recomputes.id });
  const recomputeId = recompute!.id;

  try {
    /**
     * Both models are fitted from the same set list and produce the same output
     * shape, so which one is authoritative is a single setting rather than a
     * fork in the pipeline. League bands are shared, which is what makes the
     * admin comparison view meaningful — a rank move between models is a real
     * difference in the model, not a difference in how leagues were cut.
     */
    let ratingEventRows: RatingEvent[];
    let leaderboard: LeaderboardRow[];
    let effectiveSettings = glicko;
    /** WHR fit diagnostics, recorded in the recompute's stats. */
    let modelStats: Record<string, unknown> = {};
    /**
     * Where everyone ranked before the latest night. The WHR run derives this
     * from the same history prefix its ledger is built on; the Glicko path
     * re-replays with the night withheld.
     */
    let previousRanks: Map<string, number>;

    /**
     * Fit the bands to the club's real distribution once, then leave them be —
     * except when the stored bands were fitted to a different number than the
     * board now ranks on, which is a scale change, not a re-cut of the same
     * scale. Leaving those in place would drop the entire field into the bottom
     * league the moment the ranking basis moved.
     */
    const calibrateOnce = async (provisional: LeaderboardRow[]): Promise<void> => {
      const basisChanged = glicko.leagueBandBasis !== 'club';
      if ((glicko.leagueBandsCalibrated && !basisChanged) || provisional.length < 8) return;
      const bands = calibrateLeagueBands(provisional.map((row) => row.clubRating));
      effectiveSettings = {
        ...glicko,
        leagueBands: bands,
        leagueBandsCalibrated: true,
        leagueBandBasis: 'club',
      };
      await updateGlickoSettings(db, effectiveSettings);
    };

    if (model === 'whr') {
      const first = runWhrModel({ sets: engineSets, tournaments: engineTournaments, settings: glicko });
      await calibrateOnce(first.leaderboard);
      // Re-derive leagues if calibration changed the bands. The fit itself does
      // not depend on them, so only the labels are recomputed.
      const run =
        effectiveSettings === glicko
          ? first
          : runWhrModel({ sets: engineSets, tournaments: engineTournaments, settings: effectiveSettings });
      ratingEventRows = run.events;
      leaderboard = run.leaderboard;
      previousRanks = run.previousRanks;
      modelStats = { whr: { converged: run.converged, iterations: run.iterations, periods: run.periods } };
      if (!run.converged) {
        console.warn(`WHR fit did not converge in ${run.iterations} iterations; ratings may be unstable`);
      }
    } else {
      const replay = replayRatings({ sets: engineSets, tournaments: engineTournaments, settings: glicko });
      await calibrateOnce(computeLeaderboard(replay.finalStates, glicko));
      ratingEventRows = replay.events;
      leaderboard = computeLeaderboard(replay.finalStates, effectiveSettings);
      previousRanks = ranksBeforeLastEvent(engineSets, engineTournaments, effectiveSettings);
    }

    for (let offset = 0; offset < ratingEventRows.length; offset += EVENT_INSERT_CHUNK) {
      const chunk = ratingEventRows.slice(offset, offset + EVENT_INSERT_CHUNK);
      await db.insert(ratingEvents).values(
        chunk.map((event) => ({
          recomputeId,
          playerId: event.playerId,
          seq: event.seq,
          setId: event.setId,
          tournamentId: event.tournamentId,
          isDecay: event.isDecay,
          won: event.won,
          opponentPlayerId: event.opponentId,
          preRating: event.preRating,
          postRating: event.postRating,
          preRd: event.preRd,
          postRd: event.postRd,
          preVol: event.preVol,
          postVol: event.postVol,
          weight: event.weight,
          revisedRating: event.revisedRating ?? null,
          revisedSd: event.revisedSd ?? null,
        })),
      );
    }

    if (leaderboard.length > 0) {
      await db.insert(playerRatings).values(
        leaderboard.map((row) => ({
          recomputeId,
          playerId: row.playerId,
          rank: row.rank,
          previousRank: previousRanks.get(row.playerId) ?? null,
          league: row.league,
          rating: row.rating,
          rd: row.rd,
          vol: row.vol,
          effectiveRating: row.effectiveRating,
          effectiveRd: row.effectiveRd,
          skillRating: row.skillRating,
          skillSd: row.skillSd,
          conservativeRating: row.conservativeRating,
          missedEvents: row.missedEvents,
          attendanceStreak: row.attendanceStreak,
          activityPenalty: row.activityPenalty,
          nextMissPenalty: row.nextMissPenalty,
          clubRating: row.clubRating,
          isProvisional: row.isProvisional,
          matchCount: row.matchCount,
          wins: row.wins,
          losses: row.losses,
          mainMatchCount: row.mainMatchCount,
          rookieMatchCount: row.rookieMatchCount,
          tournamentCount: row.tournamentCount,
          eventCount: row.eventCount,
          uniqueOpponentCount: row.uniqueOpponentCount,
          bridgeOpponentCount: row.bridgeOpponentCount,
          rookieRatio: row.rookieRatio,
          isolationFactor: row.isolationFactor,
          sampleConfidence: row.sampleConfidence,
          lastPlayedDate: row.lastPlayedDate,
        })),
      );
    }

    const stats = {
      players: leaderboard.length,
      sets: engineSets.length,
      events: ratingEventRows.length,
      ...modelStats,
    };
    await db
      .update(recomputes)
      .set({ status: 'complete', finishedAt: new Date(), stats })
      .where(eq(recomputes.id, recomputeId));

    await pruneOldRecomputes(db);
    return { recomputeId, model, ...stats };
  } catch (error) {
    await db
      .update(recomputes)
      .set({ status: 'failed', finishedAt: new Date(), stats: { error: String(error) } })
      .where(eq(recomputes.id, recomputeId));
    throw error;
  }
}

/**
 * Where everyone stood *before* the club's most recent night: the same model
 * over the same history, with that night's brackets withheld.
 *
 * This is what the board's ▲▼ column reports against. Diffing the last two
 * recomputes instead reported "movement" from anything that happened to trigger
 * a recompute — resolving an identity, saving a setting, switching the active
 * model, which moved half the field at once — and reported nothing when two
 * nights were synced back to back.
 *
 * Withholding a whole *event* (main + rookie bracket on one evening), not a
 * single bracket, so a player who only entered the rookie side is not compared
 * against a board that already contains the main bracket's results.
 *
 * Glicko only: the WHR run already fits every history prefix to freeze its
 * ledger, and reports the second-to-last prefix's board as `previousRanks` —
 * the same answer, from the same fit, without a second withheld run.
 */
function ranksBeforeLastEvent(
  engineSets: readonly EngineSet[],
  engineTournaments: readonly EngineTournament[],
  settings: GlickoSettings,
): Map<string, number> {
  const ranks = new Map<string, number>();
  if (engineSets.length === 0) return ranks;

  // Only brackets with rateable sets count: a registered-but-empty tournament
  // is not a night anyone could have moved on.
  const dateById = new Map(engineTournaments.map((t) => [t.id, t.eventDate]));
  const eventKeyOfSet = (set: EngineSet): string => eventKeyOf(dateById.get(set.tournamentId)!);
  const latestEventKey = engineSets.map(eventKeyOfSet).reduce((a, b) => (b > a ? b : a));

  const priorSets = engineSets.filter((set) => eventKeyOfSet(set) !== latestEventKey);
  // The club's first night has nothing behind it; every delta is null, which
  // the board renders as "–" rather than as a climb from nowhere.
  if (priorSets.length === 0) return ranks;

  const leaderboard = computeLeaderboard(
    replayRatings({ sets: priorSets, tournaments: engineTournaments, settings }).finalStates,
    settings,
  );
  for (const row of leaderboard) ranks.set(row.playerId, row.rank);
  return ranks;
}

/** Latest complete recompute ID, or null before the first recompute. */
export async function latestRecomputeId(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ id: recomputes.id })
    .from(recomputes)
    .where(eq(recomputes.status, 'complete'))
    .orderBy(sql`${recomputes.startedAt} desc`)
    .limit(1);
  return row?.id ?? null;
}

async function pruneOldRecomputes(db: Db): Promise<void> {
  const keep = await db
    .select({ id: recomputes.id })
    .from(recomputes)
    .where(eq(recomputes.status, 'complete'))
    .orderBy(sql`${recomputes.startedAt} desc`)
    .limit(KEEP_RECOMPUTES);
  const keepIds = keep.map((row) => row.id);
  if (keepIds.length === 0) return;
  await db.delete(recomputes).where(and(notInArray(recomputes.id, keepIds), ne(recomputes.status, 'running')));
}
