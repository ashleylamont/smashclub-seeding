import { loadSinglesHistory } from './inputs';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { playerRatings, ratingEvents, recomputes, settings as ratingConfig } from '@smashclub/db';
import { calibrateLeagueBands, runWhrModel, type LeaderboardRow } from '@smashclub/engine';
import { getRatingSettings, updateRatingSettings } from '../settings';

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
  const { engineSets, engineTournaments } = await loadSinglesHistory(db);

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
