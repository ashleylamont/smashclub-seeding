import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import {
  playerRatings,
  ratingEvents,
  recomputes,
  sets,
  tournaments,
  settings as ratingConfig,
} from '@smashclub/db';
import {
  calibrateLeagueBands,
  parseScoresCsv,
  runWhrModel,
  type EngineSet,
  type EngineTournament,
  type LeaderboardRow,
} from '@smashclub/engine';
import { includesResultStage, isPlayedRatingResult } from '@smashclub/shared';
import { getRatingSettings, updateRatingSettings } from '../settings';
import { nativeHistory } from '../events/nativeHistory';

export const ENGINE_VERSION = '2.0.0';
const EVENT_INSERT_CHUNK = 500;

/**
 * Full rating recompute: loads every rateable set (complete, both players
 * resolved, not excluded) from tournaments with a known event date, fits
 * them through WHR, and writes rating_events + player_ratings under a
 * new recompute row. Readers always query the latest complete recompute, so
 * a running recompute never disturbs them. Historical runs are retained with their original provenance.
 */
export async function runRecompute(
  db: Db,
): Promise<{ recomputeId: string; model: 'whr'; players: number; sets: number; events: number }> {
  // Serialize every caller with durable native publication and preserve failed-run audit.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(782392)`);
    try {
      return { result: await computeRatings(tx) };
    } catch (error) {
      return { error };
    }
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

async function computeRatings(
  db: Db,
): Promise<{ recomputeId: string; model: 'whr'; players: number; sets: number; events: number }> {
  const { rating, version } = await getRatingSettings(db);
  const { superseded } = await nativeHistory(db);

  const tournamentRows = await db
    .select({
      id: tournaments.id,
      eventDate: tournaments.eventDate,
      isRookie: tournaments.isRookie,
      challongeId: tournaments.challongeId,
      resultsMode: tournaments.resultsMode,
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
  const modes = new Map(tournamentRows.map((t) => [t.id, t.resultsMode]));

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
    .filter((row) => !superseded.has(row.tournamentId))
    .filter((row) => includesResultStage(modes.get(row.tournamentId) ?? 'auto', row.resultStage))
    .filter((row) => row.p1PlayerId !== row.p2PlayerId)
    /*
     * A `99-0` is a bye — nobody played it, so it cannot move a rating, and it
     * must not reach the game-count weighting below as the most decisive set in
     * club history. The sync marks these excluded, but that is a stored verdict
     * on rows that may predate the rule; the scoreline is the evidence, so it
     * is re-read here and the ratings come out right on the next recompute
     * rather than on the next re-sync.
     */
    .filter((row) => isPlayedRatingResult(row.scoresCsv, row.raw))
    .map((row) => {
      // Game counts feed WHR's evidence weighting (a 3-0 outrates a 3-2);
      // Unplayed scores were excluded above; unknown played scores count once.
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

  const model = 'whr' as const;
  const [recompute] = await db
    .insert(recomputes)
    .values({
      engineVersion: ENGINE_VERSION,
      model,
      settingsSnapshot: { rating, version } as unknown as Record<string, unknown>,
    })
    .returning({ id: recomputes.id });
  const recomputeId = recompute!.id;

  try {
    let effectiveSettings = rating;
    /**
     * Fit the bands to the club's real distribution once, then leave them be —
     * except when the stored bands were fitted to a different number than the
     * board now ranks on, which is a scale change, not a re-cut of the same
     * scale. Leaving those in place would drop the entire field into the bottom
     * league the moment the ranking basis moved.
     */
    const calibrateOnce = async (provisional: LeaderboardRow[]): Promise<void> => {
      const basisChanged = rating.leagueBandBasis !== 'club';
      if ((rating.leagueBandsCalibrated && !basisChanged) || provisional.length < 8) return;
      const bands = calibrateLeagueBands(provisional.map((row) => row.clubRating));
      effectiveSettings = {
        ...rating,
        leagueBands: bands,
        leagueBandsCalibrated: true,
        leagueBandBasis: 'club',
      };
    };

    const first = runWhrModel({
      sets: engineSets,
      tournaments: engineTournaments,
      settings: rating,
    });
    await calibrateOnce(first.leaderboard);
    const run =
      effectiveSettings === rating
        ? first
        : runWhrModel({
            sets: engineSets,
            tournaments: engineTournaments,
            settings: effectiveSettings,
          });
    if (!run.converged) throw new Error(`WHR did not converge in ${run.iterations} iterations`);
    const ratingEventRows = run.events;
    const leaderboard = run.leaderboard;
    const previousRanks = run.previousRanks;
    const modelStats = {
      whr: { converged: run.converged, iterations: run.iterations, periods: run.periods },
    };
    const stats = {
      players: leaderboard.length,
      sets: engineSets.length,
      events: ratingEventRows.length,
      ...modelStats,
    };

    // Publish the derived data, effective settings and completion marker together.
    await db.transaction(async (tx) => {
      const writer = tx as unknown as Db;
      const [current] = await writer
        .select({ version: ratingConfig.version })
        .from(ratingConfig)
        .where(eq(ratingConfig.id, 1))
        .for('update');
      if (current?.version !== version) throw new Error('Rating settings changed during recompute');
      const effectiveVersion =
        effectiveSettings === rating
          ? version
          : await updateRatingSettings(writer, effectiveSettings);

      for (let offset = 0; offset < ratingEventRows.length; offset += EVENT_INSERT_CHUNK) {
        const chunk = ratingEventRows.slice(offset, offset + EVENT_INSERT_CHUNK);
        await writer.insert(ratingEvents).values(
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
        await writer.insert(playerRatings).values(
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

      await writer
        .update(recomputes)
        .set({
          status: 'complete',
          finishedAt: new Date(),
          stats,
          settingsSnapshot: { rating: effectiveSettings, version: effectiveVersion },
        })
        .where(eq(recomputes.id, recomputeId));
    });

    return { recomputeId, model, ...stats };
  } catch (error) {
    await db
      .update(recomputes)
      .set({ status: 'failed', finishedAt: new Date(), stats: { error: String(error) } })
      .where(eq(recomputes.id, recomputeId));
    throw error;
  }
}

/** Latest completed WHR run with current history semantics; no legacy fallback. */
export async function latestRecomputeId(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ id: recomputes.id })
    .from(recomputes)
    .where(
      and(
        eq(recomputes.status, 'complete'),
        eq(recomputes.model, 'whr'),
        eq(recomputes.engineVersion, ENGINE_VERSION),
      ),
    )
    .orderBy(sql`${recomputes.startedAt} desc`)
    .limit(1);
  return row?.id ?? null;
}
