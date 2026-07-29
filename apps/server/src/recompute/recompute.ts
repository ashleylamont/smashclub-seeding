import { and, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { playerRatings, ratingEvents, recomputes, sets, tournaments } from '@smashclub/db';
import {
  calibrateLeagueBands,
  computeLeaderboard,
  replayRatings,
  type EngineSet,
  type EngineTournament,
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
export async function runRecompute(db: Db): Promise<{ recomputeId: string; players: number; sets: number; events: number }> {
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

  const [recompute] = await db
    .insert(recomputes)
    .values({
      engineVersion: ENGINE_VERSION,
      settingsSnapshot: { glicko, version } as unknown as Record<string, unknown>,
    })
    .returning({ id: recomputes.id });
  const recomputeId = recompute!.id;

  try {
    const replay = replayRatings({ sets: engineSets, tournaments: engineTournaments, settings: glicko });

    // The default league bands are placeholders; fit them to this club's actual
    // distribution once, then leave them alone so a league label keeps meaning
    // the same thing over time.
    let effectiveSettings = glicko;
    if (!glicko.leagueBandsCalibrated && replay.finalStates.size >= 8) {
      const provisional = computeLeaderboard(replay.finalStates, glicko);
      const bands = calibrateLeagueBands(provisional.map((row) => row.skillRating));
      effectiveSettings = { ...glicko, leagueBands: bands, leagueBandsCalibrated: true };
      await updateGlickoSettings(db, effectiveSettings);
    }

    const leaderboard = computeLeaderboard(replay.finalStates, effectiveSettings);

    for (let offset = 0; offset < replay.events.length; offset += EVENT_INSERT_CHUNK) {
      const chunk = replay.events.slice(offset, offset + EVENT_INSERT_CHUNK);
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
          uniqueOpponentCount: row.uniqueOpponentCount,
          bridgeOpponentCount: row.bridgeOpponentCount,
          rookieRatio: row.rookieRatio,
          isolationFactor: row.isolationFactor,
          sampleConfidence: row.sampleConfidence,
          lastPlayedDate: row.lastPlayedDate,
        })),
      );
    }

    const stats = { players: leaderboard.length, sets: engineSets.length, events: replay.events.length };
    await db
      .update(recomputes)
      .set({ status: 'complete', finishedAt: new Date(), stats })
      .where(eq(recomputes.id, recomputeId));

    await pruneOldRecomputes(db);
    return { recomputeId, ...stats };
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
