import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  companies,
  playerClaims,
  playerRatings,
  players,
  ratingEvents,
  recomputes,
  sets,
  tournamentParticipants,
  tournaments,
} from '@smashclub/db';
import { eventKeyOf } from '@smashclub/engine';
import { latestRecomputeId } from '../../recompute/recompute';
import { charactersByPlayer, charactersForPlayer } from '../../players/characters';
import { publicProcedure, router } from '../trpc';

const playerName = (row: { displayName: string | null; canonicalName: string }): string =>
  row.displayName ?? row.canonicalName;

export const publicRouter = router({
  leaderboard: publicProcedure.query(async ({ ctx }) => {
    // Before the first recompute there is nothing to rank, but the response
    // shape stays identical so callers need no narrowing.
    const recomputeId = await latestRecomputeId(ctx.db);
    const [recompute] = recomputeId
      ? await ctx.db.select().from(recomputes).where(eq(recomputes.id, recomputeId))
      : [];
    const rows = !recomputeId
      ? []
      : await ctx.db
      .select({
        playerId: playerRatings.playerId,
        rank: playerRatings.rank,
        league: playerRatings.league,
        /** Best estimate — the leaderboard is ranked on this. */
        skillRating: playerRatings.skillRating,
        /** Uncertainty on the estimate, for a ± band. */
        skillSd: playerRatings.skillSd,
        /** Pessimistic estimate — used for seeding, shown for reference. */
        conservativeRating: playerRatings.conservativeRating,
        rating: playerRatings.rating,
        rd: playerRatings.rd,
        effectiveRd: playerRatings.effectiveRd,
        wins: playerRatings.wins,
        losses: playerRatings.losses,
        matchCount: playerRatings.matchCount,
        tournamentCount: playerRatings.tournamentCount,
        eventCount: playerRatings.eventCount,
        sampleConfidence: playerRatings.sampleConfidence,
        rookieRatio: playerRatings.rookieRatio,
        lastPlayedDate: playerRatings.lastPlayedDate,
        canonicalName: players.canonicalName,
        displayName: players.displayName,
        companyCode: companies.code,
        companyName: companies.name,
      })
      .from(playerRatings)
      .innerJoin(players, eq(playerRatings.playerId, players.id))
      .leftJoin(companies, eq(players.companyId, companies.id))
      .where(eq(playerRatings.recomputeId, recomputeId))
      .orderBy(asc(playerRatings.rank));

    const verified = await ctx.db
      .select({ playerId: playerClaims.playerId })
      .from(playerClaims)
      .where(eq(playerClaims.status, 'approved'));
    const verifiedIds = new Set(verified.map((row) => row.playerId));

    // Rank movement against the previous complete recompute, so the board can
    // show who is climbing rather than just a static order.
    const [previous] = recomputeId
      ? await ctx.db
          .select({ id: recomputes.id })
          .from(recomputes)
          .where(and(eq(recomputes.status, 'complete'), ne(recomputes.id, recomputeId)))
          .orderBy(desc(recomputes.startedAt))
          .limit(1)
      : [];
    const previousRanks = new Map<string, number>();
    if (previous) {
      const previousRows = await ctx.db
        .select({ playerId: playerRatings.playerId, rank: playerRatings.rank })
        .from(playerRatings)
        .where(eq(playerRatings.recomputeId, previous.id));
      for (const row of previousRows) previousRanks.set(row.playerId, row.rank);
    }

    /*
     * Club-wide event count for the masthead. Derived here rather than in the web
     * app: what groups brackets into an event is an engine rule (`eventKeyOf`),
     * and apps/web has no dependency on the engine, so re-deriving it there would
     * duplicate the definition where it could silently drift.
     */
    const eventDates = await ctx.db
      .select({ eventDate: tournaments.eventDate })
      .from(tournaments)
      .where(isNotNull(tournaments.eventDate));
    const eventCount = new Set(
      eventDates.map((row) => eventKeyOf(row.eventDate!.toISOString())),
    ).size;

    const characters = await charactersByPlayer(
      ctx.db,
      rows.map((row) => row.playerId),
    );

    return {
      computedAt: recompute?.finishedAt?.toISOString() ?? null,
      /** Which rating model produced these numbers. */
      model: recompute?.model ?? 'glicko2',
      /** Occasions the club has run, not brackets — a main+rookie night is one. */
      eventCount,
      rows: rows.map((row) => {
        const previousRank = previousRanks.get(row.playerId);
        return {
          ...row,
          name: playerName(row),
          verified: verifiedIds.has(row.playerId),
          /** Mains, in the player's chosen order; drawn as head icons. */
          characters: characters.get(row.playerId) ?? [],
          /** Places gained since the previous recompute; null if newly ranked. */
          rankDelta: previousRank === undefined ? null : previousRank - row.rank,
        };
      }),
    };
  }),

  player: publicProcedure.input(z.object({ playerId: z.uuid() })).query(async ({ ctx, input }) => {
    const [player] = await ctx.db
      .select({
        id: players.id,
        canonicalName: players.canonicalName,
        displayName: players.displayName,
        status: players.status,
        mergedIntoPlayerId: players.mergedIntoPlayerId,
        companyCode: companies.code,
        companyName: companies.name,
      })
      .from(players)
      .leftJoin(companies, eq(players.companyId, companies.id))
      .where(eq(players.id, input.playerId));
    if (!player) return null;
    if (player.status === 'merged' && player.mergedIntoPlayerId) {
      return { redirectTo: player.mergedIntoPlayerId };
    }

    const recomputeId = await latestRecomputeId(ctx.db);
    let ratingRow = null;
    let events: Array<Record<string, unknown>> = [];
    if (recomputeId) {
      const [rating] = await ctx.db
        .select()
        .from(playerRatings)
        .where(and(eq(playerRatings.recomputeId, recomputeId), eq(playerRatings.playerId, input.playerId)));
      ratingRow = rating ?? null;

      const opponents = players; // alias for readability in the join below
      const eventRows = await ctx.db
        .select({
          seq: ratingEvents.seq,
          isDecay: ratingEvents.isDecay,
          won: ratingEvents.won,
          preRating: ratingEvents.preRating,
          postRating: ratingEvents.postRating,
          preRd: ratingEvents.preRd,
          postRd: ratingEvents.postRd,
          weight: ratingEvents.weight,
          tournamentId: ratingEvents.tournamentId,
          tournamentName: tournaments.name,
          tournamentDate: tournaments.eventDate,
          isRookie: tournaments.isRookie,
          opponentPlayerId: ratingEvents.opponentPlayerId,
          opponentCanonicalName: opponents.canonicalName,
          opponentDisplayName: opponents.displayName,
        })
        .from(ratingEvents)
        .innerJoin(tournaments, eq(ratingEvents.tournamentId, tournaments.id))
        .leftJoin(opponents, eq(ratingEvents.opponentPlayerId, opponents.id))
        .where(and(eq(ratingEvents.recomputeId, recomputeId), eq(ratingEvents.playerId, input.playerId)))
        .orderBy(asc(ratingEvents.seq));
      events = eventRows.map((row) => ({
        ...row,
        tournamentDate: row.tournamentDate?.toISOString() ?? null,
        opponentName: row.opponentCanonicalName
          ? (row.opponentDisplayName ?? row.opponentCanonicalName)
          : null,
      }));
    }

    const verified = await ctx.db
      .select({ id: playerClaims.id })
      .from(playerClaims)
      .where(and(eq(playerClaims.playerId, input.playerId), eq(playerClaims.status, 'approved')));

    return {
      player: {
        id: player.id,
        name: playerName(player),
        canonicalName: player.canonicalName,
        companyCode: player.companyCode,
        companyName: player.companyName,
        verified: verified.length > 0,
        characters: await charactersForPlayer(ctx.db, input.playerId),
      },
      rating: ratingRow,
      events,
    };
  }),

  /** Full rating history for every ranked player (the RatingsOverTime chart). */
  ratingHistory: publicProcedure.query(async ({ ctx }) => {
    const recomputeId = await latestRecomputeId(ctx.db);
    if (!recomputeId) return { events: [], players: [] };
    const eventRows = await ctx.db
      .select({
        seq: ratingEvents.seq,
        playerId: ratingEvents.playerId,
        isDecay: ratingEvents.isDecay,
        /** Null for decay events; drives the last-five form pips. */
        won: ratingEvents.won,
        postRating: ratingEvents.postRating,
        postRd: ratingEvents.postRd,
        tournamentId: ratingEvents.tournamentId,
      })
      .from(ratingEvents)
      .where(eq(ratingEvents.recomputeId, recomputeId))
      .orderBy(asc(ratingEvents.seq));
    const playerRows = await ctx.db
      .select({
        playerId: playerRatings.playerId,
        rank: playerRatings.rank,
        conservativeRating: playerRatings.conservativeRating,
        canonicalName: players.canonicalName,
        displayName: players.displayName,
      })
      .from(playerRatings)
      .innerJoin(players, eq(playerRatings.playerId, players.id))
      .where(eq(playerRatings.recomputeId, recomputeId))
      .orderBy(asc(playerRatings.rank));
    return {
      events: eventRows,
      players: playerRows.map((row) => ({ ...row, name: playerName(row) })),
    };
  }),

  tournaments: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(tournaments).orderBy(desc(tournaments.eventDate));
    return rows.map((row) => ({
      id: row.id,
      slug: row.challongeSlug,
      name: row.name,
      eventDate: row.eventDate?.toISOString() ?? null,
      isRookie: row.isRookie,
      challongeState: row.challongeState,
      syncState: row.syncState,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      /** Open live-monitoring window, if any; null once it expires or the bracket completes. */
      liveUntil: row.liveUntil?.toISOString() ?? null,
    }));
  }),

  tournament: publicProcedure.input(z.object({ slug: z.string() })).query(async ({ ctx, input }) => {
    const [tournament] = await ctx.db.select().from(tournaments).where(eq(tournaments.challongeSlug, input.slug));
    if (!tournament) return null;

    const participants = await ctx.db
      .select({
        id: tournamentParticipants.id,
        cleanedName: tournamentParticipants.cleanedName,
        playerId: tournamentParticipants.playerId,
        challongeSeed: tournamentParticipants.challongeSeed,
        finalRank: tournamentParticipants.finalRank,
        canonicalName: players.canonicalName,
        displayName: players.displayName,
      })
      .from(tournamentParticipants)
      .leftJoin(players, eq(tournamentParticipants.playerId, players.id))
      .where(eq(tournamentParticipants.tournamentId, tournament.id));

    const participantName = new Map(
      participants.map((p) => [
        p.id,
        p.canonicalName ? (p.displayName ?? p.canonicalName) : p.cleanedName,
      ]),
    );

    const setRows = await ctx.db
      .select()
      .from(sets)
      .where(eq(sets.tournamentId, tournament.id))
      .orderBy(asc(sets.suggestedPlayOrder), asc(sets.challongeMatchId));

    return {
      id: tournament.id,
      slug: tournament.challongeSlug,
      name: tournament.name,
      eventDate: tournament.eventDate?.toISOString() ?? null,
      isRookie: tournament.isRookie,
      challongeState: tournament.challongeState,
      syncState: tournament.syncState,
      lastSyncedAt: tournament.lastSyncedAt?.toISOString() ?? null,
      participants: participants
        .map((p) => ({
          id: p.id,
          playerId: p.playerId,
          name: participantName.get(p.id)!,
          challongeSeed: p.challongeSeed,
          finalRank: p.finalRank,
        }))
        .sort((a, b) => (a.finalRank ?? 1e9) - (b.finalRank ?? 1e9) || (a.challongeSeed ?? 1e9) - (b.challongeSeed ?? 1e9)),
      sets: setRows.map((row) => ({
        id: row.id,
        round: row.round,
        identifier: row.identifier,
        state: row.state,
        winner: row.winner,
        scoresCsv: row.scoresCsv,
        excludedFromRatings: row.excludedFromRatings,
        completedAt: row.completedAt?.toISOString() ?? null,
        p1Name: row.p1ParticipantId ? (participantName.get(row.p1ParticipantId) ?? null) : null,
        p2Name: row.p2ParticipantId ? (participantName.get(row.p2ParticipantId) ?? null) : null,
        p1PlayerId: row.p1PlayerId,
        p2PlayerId: row.p2PlayerId,
      })),
    };
  }),

  /** Player search for the claim flow and admin tools. */
  searchPlayers: publicProcedure
    .input(z.object({ query: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: players.id,
          canonicalName: players.canonicalName,
          displayName: players.displayName,
          companyCode: companies.code,
        })
        .from(players)
        .leftJoin(companies, eq(players.companyId, companies.id))
        .where(and(eq(players.status, 'active'), ilike(players.canonicalName, `%${input.query}%`)))
        .limit(20);
      const claims = rows.length
        ? await ctx.db
            .select({ playerId: playerClaims.playerId })
            .from(playerClaims)
            .where(
              and(
                inArray(
                  playerClaims.playerId,
                  rows.map((row) => row.id),
                ),
                eq(playerClaims.status, 'approved'),
              ),
            )
        : [];
      const claimed = new Set(claims.map((row) => row.playerId));
      return rows.map((row) => ({
        id: row.id,
        name: row.displayName ?? row.canonicalName,
        companyCode: row.companyCode,
        verified: claimed.has(row.id),
      }));
    }),
});
