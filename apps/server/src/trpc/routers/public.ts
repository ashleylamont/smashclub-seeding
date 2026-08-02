import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
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
import { publicParticipantName, publicPlayerName } from '@smashclub/shared';
import { latestRecomputeId } from '../../recompute/recompute';
import { getGlickoSettings } from '../../settings';
import { charactersByPlayer, charactersForPlayer } from '../../players/characters';
import { loadRecap } from '../../recap/recap';
import { publicProcedure, router } from '../trpc';

const playerName = publicPlayerName;

/*
 * Nothing on this router is authenticated, so every response here is public.
 * `canonicalName` is the registry's record of a real person's name; the club
 * publishes aliases instead. Queries below still *select* it — it is what the
 * alias is derived from when a player has not chosen one — but it is destructured
 * away rather than spread into a response, so adding a column to one of these
 * selects cannot quietly publish it.
 */

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
        /** Rank before the club's most recent night; null if unrated then. */
        previousRank: playerRatings.previousRank,
        league: playerRatings.league,
        /** Best estimate, shown with its ± band. */
        skillRating: playerRatings.skillRating,
        /** Uncertainty on the estimate, for a ± band. */
        skillSd: playerRatings.skillSd,
        /** Pessimistic estimate — what bracket seeding is ranked on. */
        conservativeRating: playerRatings.conservativeRating,
        /** Skill less the activity penalty — what this board is ranked on. */
        clubRating: playerRatings.clubRating,
        /** Points currently docked for missed club nights; 0 for most people. */
        activityPenalty: playerRatings.activityPenalty,
        /** What missing the next club night would cost, so it can be shown up front. */
        nextMissPenalty: playerRatings.nextMissPenalty,
        missedEvents: playerRatings.missedEvents,
        attendanceStreak: playerRatings.attendanceStreak,
        /** Too little history to have earned the number yet. */
        isProvisional: playerRatings.isProvisional,
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

    /*
     * The attendance policy in force, so the site can *state* it rather than
     * hardcode it in prose that silently goes stale the first time an admin
     * retunes a number. A policy nobody can read is indistinguishable from an
     * arbitrary one, which was the main charge against ranking on RD.
     */
    const { glicko } = await getGlickoSettings(ctx.db);
    const activityPolicy = {
      graceEvents: glicko.activityGraceEvents,
      penaltyPerEvent: glicko.activityPenaltyPerEvent,
      penaltyCap: glicko.activityPenaltyCap,
    };

    return {
      computedAt: recompute?.finishedAt?.toISOString() ?? null,
      /** Which rating model produced these numbers. */
      model: recompute?.model ?? 'glicko2',
      /** Occasions the club has run, not brackets — a main+rookie night is one. */
      eventCount,
      activityPolicy,
      rows: rows.map(({ canonicalName, displayName, ...row }) => ({
        ...row,
        /** The public alias; the names it was derived from stay server-side. */
        name: playerName({ canonicalName, displayName }),
        verified: verifiedIds.has(row.playerId),
        /** Mains, in the player's chosen order; drawn as head icons. */
        characters: characters.get(row.playerId) ?? [],
        /**
         * Places gained over the club's most recent night; null if this player
         * had no rating before it. Recorded by the recompute against a replay
         * that withholds that night, so it reports what the games did and not
         * what any other recompute happened to change.
         */
        rankDelta: row.previousRank === null ? null : row.previousRank - row.rank,
      })),
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
    let model = 'glicko2';
    if (recomputeId) {
      const [recompute] = await ctx.db
        .select({ model: recomputes.model })
        .from(recomputes)
        .where(eq(recomputes.id, recomputeId));
      model = recompute?.model ?? model;
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
          /** WHR only: the current fit's hindsight estimate at this night. */
          revisedRating: ratingEvents.revisedRating,
          revisedSd: ratingEvents.revisedSd,
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
      events = eventRows.map(({ opponentCanonicalName, opponentDisplayName, ...row }) => ({
        ...row,
        tournamentDate: row.tournamentDate?.toISOString() ?? null,
        opponentName: opponentCanonicalName
          ? publicPlayerName({
              displayName: opponentDisplayName,
              canonicalName: opponentCanonicalName,
            })
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
        companyCode: player.companyCode,
        companyName: player.companyName,
        verified: verified.length > 0,
        characters: await charactersForPlayer(ctx.db, input.playerId),
      },
      rating: ratingRow,
      events,
      /** Which rating model produced the events — the profile explains deltas differently per model. */
      model,
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
      players: playerRows.map(({ canonicalName, displayName, ...row }) => ({
        ...row,
        name: playerName({ canonicalName, displayName }),
      })),
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
        companyCode: companies.code,
      })
      .from(tournamentParticipants)
      .leftJoin(players, eq(tournamentParticipants.playerId, players.id))
      .leftJoin(companies, eq(players.companyId, companies.id))
      .where(eq(tournamentParticipants.tournamentId, tournament.id));

    const participantName = new Map(participants.map((p) => [p.id, publicParticipantName(p)]));

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
          companyCode: p.companyCode,
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
        /* Participant ids as well as names: a screen that wants a player's seed
           or company alongside a set should join on the id rather than match on
           a display name, which is neither unique nor stable. */
        p1ParticipantId: row.p1ParticipantId,
        p2ParticipantId: row.p2ParticipantId,
        p1Name: row.p1ParticipantId ? (participantName.get(row.p1ParticipantId) ?? null) : null,
        p2Name: row.p2ParticipantId ? (participantName.get(row.p2ParticipantId) ?? null) : null,
        p1PlayerId: row.p1PlayerId,
        p2PlayerId: row.p2PlayerId,
      })),
    };
  }),

  /**
   * The night's recap — every bracket that ran on the same evening as `slug`,
   * reduced to ranked facts. Public and unauthenticated so a recap link can be
   * shared out of the club.
   */
  recap: publicProcedure.input(z.object({ slug: z.string() })).query(async ({ ctx, input }) => {
    return loadRecap(ctx.db, input.slug);
  }),

  /**
   * Player search for the claim flow.
   *
   * Matches on the public alias only. Matching the canonical name would not
   * publish it directly, but it would answer "does a player whose registry name
   * contains this substring exist?" for any substring a caller cares to try,
   * which reconstructs the same names a probe at a time. So someone claiming
   * their player searches the name the board shows — their first name finds it.
   *
   * Filtering in JS rather than SQL because the alias is only a column when the
   * player chose one; otherwise it is derived. The club's roster is small enough
   * that scanning the active players costs less than keeping a derived column
   * correct in two places.
   *
   * Admin tools do not use this — they load the full roster (admin.players) and
   * search names and stored aliases client-side.
   */
  searchPlayers: publicProcedure
    .input(z.object({ query: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const query = input.query.trim().toLowerCase();
      const rows = (
        await ctx.db
          .select({
            id: players.id,
            canonicalName: players.canonicalName,
            displayName: players.displayName,
            companyCode: companies.code,
          })
          .from(players)
          .leftJoin(companies, eq(players.companyId, companies.id))
          .where(eq(players.status, 'active'))
      )
        .map((row) => ({ id: row.id, name: playerName(row), companyCode: row.companyCode }))
        .filter((row) => row.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20);
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
      return rows.map((row) => ({ ...row, verified: claimed.has(row.id) }));
    }),
});
