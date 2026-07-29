import { and, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { playerRatings, ratingEvents, recomputes, sets, tournaments } from '@smashclub/db';
import {
  calibrateLeagueBands,
  computeLeaderboard,
  replayRatings,
  runWhrModel,
  type EngineSet,
  type EngineTournament,
  type LeaderboardRow,
  type RatingEvent,
} from '@smashclub/engine';
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
    .map((row) => ({
      id: row.id,
      tournamentId: row.tournamentId,
      p1PlayerId: row.p1PlayerId!,
      p2PlayerId: row.p2PlayerId!,
      winner: row.winner as 1 | 2,
      suggestedPlayOrder: row.suggestedPlayOrder,
      completedAt: row.completedAt?.toISOString() ?? null,
      challongeMatchId: row.challongeMatchId,
    }));

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

    /** Fit the bands to the club's real distribution once, then leave them be. */
    const calibrateOnce = async (provisional: LeaderboardRow[]): Promise<void> => {
      if (glicko.leagueBandsCalibrated || provisional.length < 8) return;
      const bands = calibrateLeagueBands(provisional.map((row) => row.skillRating));
      effectiveSettings = { ...glicko, leagueBands: bands, leagueBandsCalibrated: true };
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
      if (!run.converged) {
        console.warn(`WHR fit did not converge in ${run.iterations} iterations; ratings may be unstable`);
      }
    } else {
      const replay = replayRatings({ sets: engineSets, tournaments: engineTournaments, settings: glicko });
      await calibrateOnce(computeLeaderboard(replay.finalStates, glicko));
      ratingEventRows = replay.events;
      leaderboard = computeLeaderboard(replay.finalStates, effectiveSettings);
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
        })),
      );
    }

    if (leaderboard.length > 0) {
      await db.insert(playerRatings).values(
        leaderboard.map((row) => ({
          recomputeId,
          playerId: row.playerId,
          rank: row.rank,
          league: row.league,
          rating: row.rating,
          rd: row.rd,
          vol: row.vol,
          effectiveRating: row.effectiveRating,
          effectiveRd: row.effectiveRd,
          skillRating: row.skillRating,
          skillSd: row.skillSd,
          conservativeRating: row.conservativeRating,
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

    const stats = { players: leaderboard.length, sets: engineSets.length, events: ratingEventRows.length };
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
