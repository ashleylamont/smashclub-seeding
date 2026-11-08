import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  companies,
  playerRatings,
  players,
  recomputes,
  sets,
  tournaments,
  type Db,
} from '@smashclub/db';
import {
  DISPLAY_CENTRE,
  NATURAL_TO_DISPLAY,
  parseScoresCsv,
  probabilityFromRatings,
} from '@smashclub/engine';
import { isBracketOver, isPlayedRatingResult, publicPlayerName } from '@smashclub/shared';
import { z } from 'zod';
import { latestRecomputeId } from '../recompute/recompute';
import { nativeHistoryForTournaments } from './nativeHistory';

const uuid = z.uuid();
export const headToHeadInput = z.object({ first: uuid.optional(), second: uuid.optional() });

const IDENTITY_LIMIT = 128;
const PAIR_LIMIT = 2048;
const RECENT_LIMIT = 10;

/** Resolve each requested ID and its merged predecessors without loading the player registry.
 * UNION terminates even if old data contains a cycle. A chain without an active end is unavailable. */
async function pairIdentities(db: Db, { first, second }: z.infer<typeof headToHeadInput>) {
  return db
    .select({
      side: sql<number>`identity.side`,
      historicalId: sql<string>`identity.id`,
      id: players.id,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
      companyCode: companies.code,
    })
    .from(
      sql`(
      with recursive requested(side, id) as (values (0, ${first ?? null}::uuid), (1, ${second ?? null}::uuid)),
      redirects(side, id, status, target) as (
        select requested.side, p.id, p.status, p.merged_into_player_id
        from requested join players p on p.id = requested.id
        union
        select redirects.side, p.id, p.status, p.merged_into_player_id
        from redirects join players p on p.id = redirects.target
        where redirects.status = 'merged'
      ),
      identities(side, id, canonical_id) as (
        select side, id, id from redirects where status = 'active'
        union
        select identities.side, p.id, identities.canonical_id
        from identities join players p on p.merged_into_player_id = identities.id
        where p.status = 'merged'
      )
      select * from identities
    ) as identity`,
    )
    .innerJoin(players, eq(players.id, sql`identity.canonical_id`))
    .leftJoin(companies, eq(companies.id, players.companyId))
    .limit(IDENTITY_LIMIT + 1);
}

async function recentPairResults(db: Db, firstIds: string[], secondIds: string[]) {
  const rows = await db
    .select({
      id: sets.id,
      slug: tournaments.challongeSlug,
      event: tournaments.name,
      eventDate: tournaments.eventDate,
      challongeState: tournaments.challongeState,
      completedAt: sets.completedAt,
      winner: sets.winner,
      player1Id: sets.p1PlayerId,
      scoresCsv: sets.scoresCsv,
      provider: tournaments.provider,
      nativePlanId: sql<string | null>`${tournaments.raw}->>'eventPlanId'`,
      nativeResultId: sql<string | null>`${tournaments.raw}->>'resultId'`,
      outcome: sql<string | null>`${sets.raw}->>'outcome'`,
      tournamentId: sets.tournamentId,
    })
    .from(sets)
    .innerJoin(tournaments, eq(sets.tournamentId, tournaments.id))
    .where(
      and(
        eq(tournaments.competitionFormat, 'singles'),
        // Match the partial pair index predicate for both orientations.
        sql`${sets.state} = 'complete'`,
        inArray(sets.winner, [1, 2]),
        or(
          and(inArray(sets.p1PlayerId, firstIds), inArray(sets.p2PlayerId, secondIds)),
          and(inArray(sets.p1PlayerId, secondIds), inArray(sets.p2PlayerId, firstIds)),
        ),
      ),
    )
    .orderBy(
      sql`coalesce(${tournaments.eventDate}, ${sets.completedAt}) desc nulls last`,
      sql`${sets.suggestedPlayOrder} desc nulls last`,
      sql`${sets.completedAt} desc nulls last`,
      desc(sets.challongeMatchId),
      desc(sets.id),
    )
    .limit(PAIR_LIMIT + 1);
  if (rows.length > PAIR_LIMIT) return null;

  const legacyPlanIds = rows.flatMap((row) => {
    if (row.provider !== 'native') return [];
    const id = uuid.safeParse(row.nativePlanId);
    return id.success ? [id.data.toLowerCase()] : [];
  });
  const native = await nativeHistoryForTournaments(
    db,
    [...new Set(rows.map((row) => row.tournamentId))],
    legacyPlanIds,
    PAIR_LIMIT,
  );
  if (!native) return null;

  const first = new Set(firstIds);
  const now = Date.now();
  const meetings = rows.flatMap((row) => {
    if (native.superseded.has(row.tournamentId)) return [];
    const hasReceipt = native.byTournament.has(row.tournamentId);
    if (!hasReceipt && row.provider === 'native') {
      if (row.nativePlanId && native.withdrawnPlans.has(row.nativePlanId.toLowerCase())) return [];
      // A journal export is visible only through its committed publication receipt.
      if (row.nativeResultId) return [];
    }
    // Use the public bracket's historical boundary for provider and pre-journal results.
    if (
      !hasReceipt &&
      !isBracketOver(
        { challongeState: row.challongeState, eventDate: row.eventDate?.toISOString() ?? null },
        now,
      )
    )
      return [];
    // A rating exclusion or final-stage-only rating policy does not erase a
    // played result. Stored outcomes and historical score sentinels do.
    if (
      row.outcome === 'no_contest' ||
      !isPlayedRatingResult(row.scoresCsv, { outcome: row.outcome })
    )
      return [];
    const player1IsFirst = first.has(row.player1Id!);
    const score = parseScoresCsv(row.scoresCsv);
    // The official winner still counts when the game margin is missing or contradictory.
    const scoreAgrees = row.winner === 1 ? score.p1 > score.p2 : score.p2 > score.p1;
    const games: [number, number] | null =
      score.unknown || !scoreAgrees
        ? null
        : player1IsFirst
          ? [score.p1, score.p2]
          : [score.p2, score.p1];
    return [
      {
        id: row.id,
        event: row.event,
        slug: row.slug,
        date: (row.eventDate ?? row.completedAt)?.toISOString() ?? null,
        winner: player1IsFirst === (row.winner === 1) ? (0 as const) : (1 as const),
        games,
      },
    ];
  });

  const wins: [number, number] = [0, 0];
  const gamesWon: [number, number] = [0, 0];
  let scoredMeetings = 0;
  for (const meeting of meetings) {
    wins[meeting.winner]++;
    if (meeting.games) {
      scoredMeetings++;
      gamesWon[0] += meeting.games[0];
      gamesWon[1] += meeting.games[1];
    }
  }
  return { wins, gamesWon, scoredMeetings, recent: meetings.slice(0, RECENT_LIMIT) };
}

async function publishedForecast(db: Db, first: string, second: string) {
  const recomputeId = await latestRecomputeId(db);
  if (!recomputeId) return null;
  const rows = await db
    .select({
      playerId: playerRatings.playerId,
      rating: playerRatings.rating,
      rd: playerRatings.rd,
      matchCount: playerRatings.matchCount,
      provisional: playerRatings.isProvisional,
      finishedAt: recomputes.finishedAt,
    })
    .from(playerRatings)
    .innerJoin(recomputes, eq(playerRatings.recomputeId, recomputes.id))
    .where(
      and(
        eq(playerRatings.recomputeId, recomputeId),
        inArray(playerRatings.playerId, [first, second]),
      ),
    );
  const a = rows.find((row) => row.playerId === first);
  const b = rows.find((row) => row.playerId === second);
  if (!a?.finishedAt || !b) return null;
  if (
    [a, b].some(
      ({ rating, rd, matchCount }) =>
        !Number.isFinite(rating) || !Number.isFinite(rd) || rd < 0 || matchCount === 0,
    )
  )
    return null;

  const probability = probabilityFromRatings(
    (a.rating - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
    (b.rating - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
    (a.rd / NATURAL_TO_DISPLAY) ** 2 + (b.rd / NATURAL_TO_DISPLAY) ** 2,
  );
  return {
    firstWinChance: probability,
    ratedAt: a.finishedAt.toISOString(),
    provisional: a.provisional || b.provisional,
  };
}

export function readHeadToHead(db: Db, input: z.infer<typeof headToHeadInput>) {
  return db.transaction(
    async (tx) => {
      const identities = await pairIdentities(tx, input);
      const toPublicPlayer = (side: number) => {
        const row = identities.find((identity) => identity.side === side);
        return row
          ? { id: row.id, name: publicPlayerName(row), companyCode: row.companyCode }
          : null;
      };
      const first = toPublicPlayer(0);
      const second = toPublicPlayer(1);
      const pair = [first, second] as const;
      if (identities.length > IDENTITY_LIMIT)
        return { status: 'unavailable' as const, players: [null, null] as const };
      if ((input.first && !first) || (input.second && !second))
        return { status: 'missing_player' as const, players: pair };
      if (!first || !second) return { status: 'choose_players' as const, players: pair };
      if (first.id === second.id)
        return { status: 'same_player' as const, players: [first, second] as const };

      const ids = (side: number) =>
        identities.filter((row) => row.side === side).map((row) => row.historicalId);
      const history = await recentPairResults(tx, ids(0), ids(1));
      const forecast = await publishedForecast(tx, first.id, second.id);
      return { status: 'ready' as const, players: [first, second] as const, history, forecast };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
