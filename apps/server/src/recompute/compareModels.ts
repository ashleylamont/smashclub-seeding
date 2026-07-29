import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { companies, players, sets, tournaments } from '@smashclub/db';
import {
  computeLeaderboard,
  replayRatings,
  runWhrModel,
  type EngineSet,
  type EngineTournament,
  type LeaderboardRow,
} from '@smashclub/engine';
import { getGlickoSettings } from '../settings';

/**
 * Fits both rating models over the same history and reports how the published
 * order would differ.
 *
 * Nothing here writes: switching which model is authoritative moves every
 * member's number, so it should never be a blind setting change. This is the
 * "look before you leap" view — run it, read the disagreement, then switch.
 */
export interface ModelComparisonRow {
  playerId: string;
  name: string;
  companyCode: string | null;
  matchCount: number;
  glicko: { rank: number; skillRating: number; skillSd: number } | null;
  whr: { rank: number; skillRating: number; skillSd: number } | null;
  /** Places gained moving from Glicko-2 to WHR; null if only one model ranks them. */
  rankDelta: number | null;
}

export interface ModelComparison {
  activeModel: string;
  players: number;
  sets: number;
  /** Median absolute rank movement between the two models. */
  medianAbsRankDelta: number;
  /** How many of the current top ten each model shares with the other. */
  topTenOverlap: number;
  /** Players whose rank moves by more than this many places. */
  bigMovers: number;
  whrConverged: boolean;
  whrIterations: number;
  rows: ModelComparisonRow[];
}

/** A rank move larger than this is worth a human looking at. */
const BIG_MOVE = 10;

export async function compareModels(db: Db): Promise<ModelComparison> {
  const { glicko } = await getGlickoSettings(db);

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

  const replay = replayRatings({ sets: engineSets, tournaments: engineTournaments, settings: glicko });
  const glickoBoard = computeLeaderboard(replay.finalStates, glicko);
  const whrRun = runWhrModel({ sets: engineSets, tournaments: engineTournaments, settings: glicko });

  const byId = <T extends LeaderboardRow>(rows: readonly T[]): Map<string, T> =>
    new Map(rows.map((row) => [row.playerId, row]));
  const glickoById = byId(glickoBoard);
  const whrById = byId(whrRun.leaderboard);

  const playerIds = [...new Set([...glickoById.keys(), ...whrById.keys()])];
  const nameRows = playerIds.length
    ? await db
        .select({
          id: players.id,
          canonicalName: players.canonicalName,
          displayName: players.displayName,
          companyCode: companies.code,
        })
        .from(players)
        .leftJoin(companies, eq(players.companyId, companies.id))
        .where(inArray(players.id, playerIds))
    : [];
  const nameById = new Map(nameRows.map((row) => [row.id, row]));

  const rows: ModelComparisonRow[] = playerIds.map((playerId) => {
    const g = glickoById.get(playerId) ?? null;
    const w = whrById.get(playerId) ?? null;
    const meta = nameById.get(playerId);
    return {
      playerId,
      name: meta ? (meta.displayName ?? meta.canonicalName) : playerId,
      companyCode: meta?.companyCode ?? null,
      matchCount: g?.matchCount ?? w?.matchCount ?? 0,
      glicko: g ? { rank: g.rank, skillRating: g.skillRating, skillSd: g.skillSd } : null,
      whr: w ? { rank: w.rank, skillRating: w.skillRating, skillSd: w.skillSd } : null,
      rankDelta: g && w ? g.rank - w.rank : null,
    };
  });

  // Biggest disagreements first — that is what a reviewer is looking for.
  rows.sort((a, b) => Math.abs(b.rankDelta ?? 0) - Math.abs(a.rankDelta ?? 0) || (a.glicko?.rank ?? 0) - (b.glicko?.rank ?? 0));

  const deltas = rows
    .map((row) => row.rankDelta)
    .filter((delta): delta is number => delta !== null)
    .map(Math.abs)
    .sort((a, b) => a - b);
  const medianAbsRankDelta = deltas.length ? deltas[Math.floor(deltas.length / 2)]! : 0;

  const glickoTopTen = new Set(glickoBoard.slice(0, 10).map((row) => row.playerId));
  const topTenOverlap = whrRun.leaderboard.slice(0, 10).filter((row) => glickoTopTen.has(row.playerId)).length;

  return {
    activeModel: glicko.activeModel,
    players: playerIds.length,
    sets: engineSets.length,
    medianAbsRankDelta,
    topTenOverlap,
    bigMovers: deltas.filter((delta) => delta > BIG_MOVE).length,
    whrConverged: whrRun.converged,
    whrIterations: whrRun.iterations,
    rows,
  };
}
