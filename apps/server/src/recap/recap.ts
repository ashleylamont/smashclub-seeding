import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import {
  companies,
  playerRatings,
  players,
  ratingEvents,
  sets,
  tournamentParticipants,
  tournaments,
} from '@smashclub/db';
import {
  buildRecap,
  eventKeyOf,
  formatFact,
  pairKey,
  type RankedRecapFact,
  type RecapHistory,
  type RecapParticipant,
  type RecapResult,
  type RecapSet,
  type RecapTournament,
} from '@smashclub/engine';
import { publicPlayerName } from '@smashclub/shared';
import { latestRecomputeId } from '../recompute/recompute';
import { charactersByPlayer } from '../players/characters';

/**
 * Assembles a night's recap: resolves a slug to every bracket that ran that
 * evening, loads what the facts engine needs, and hands off.
 *
 * All the *decisions* live in the engine; this module is the I/O around it. The
 * one judgement it makes is what counts as "before tonight", and it makes it
 * with `seq` rather than dates — `rating_events.seq` is the replay's own
 * processing order, so it is the only ordering guaranteed to agree with the
 * ratings themselves when two brackets share a date.
 */

/**
 * A fact with its copy already applied.
 *
 * The web app has no dependency on the engine — see the note on the
 * leaderboard's event count — so the headline and detail are rendered here
 * rather than in the browser. The wording still has exactly one home
 * (`formatFact`), which is the point: a recap page, a share image and any
 * future chat post all describe a night identically.
 */
export interface LoadedRecapFact extends RankedRecapFact {
  headline: string;
  detail: string;
}

export interface LoadedRecap extends Omit<RecapResult, 'tournaments' | 'facts'> {
  /** The night's brackets, main first, each addressable by its own slug. */
  tournaments: Array<RecapTournament & { slug: string }>;
  facts: LoadedRecapFact[];
  /** Canonical slug for this night — the main bracket's. */
  slug: string;
}

export async function loadRecap(db: Db, slug: string): Promise<LoadedRecap | null> {
  const [anchor] = await db.select().from(tournaments).where(eq(tournaments.challongeSlug, slug));
  if (!anchor) return null;

  /*
   * The night is every bracket sharing the anchor's event key — normally a main
   * and a rookie bracket. A tournament with no event date cannot be grouped, so
   * it is a night of one.
   */
  const allDated = await db
    .select({
      id: tournaments.id,
      name: tournaments.name,
      slug: tournaments.challongeSlug,
      eventDate: tournaments.eventDate,
      isRookie: tournaments.isRookie,
      challongeState: tournaments.challongeState,
    })
    .from(tournaments)
    .where(isNotNull(tournaments.eventDate))
    .orderBy(asc(tournaments.eventDate));

  const anchorKey = anchor.eventDate ? eventKeyOf(anchor.eventDate.toISOString()) : null;
  const nightRows =
    anchorKey === null
      ? []
      : allDated.filter((t) => eventKeyOf(t.eventDate!.toISOString()) === anchorKey);

  const nightTournaments: RecapTournament[] =
    nightRows.length > 0
      ? nightRows.map((t) => ({
          id: t.id,
          name: t.name,
          eventDate: t.eventDate!.toISOString(),
          isRookie: t.isRookie,
          challongeState: t.challongeState,
        }))
      : [
          {
            id: anchor.id,
            name: anchor.name,
            eventDate: anchor.eventDate?.toISOString() ?? null,
            isRookie: anchor.isRookie,
            challongeState: anchor.challongeState,
          },
        ];
  const nightIds = nightTournaments.map((t) => t.id);
  const slugById = new Map(nightRows.map((t) => [t.id, t.slug]));
  slugById.set(anchor.id, anchor.challongeSlug);

  // --- participants -------------------------------------------------------

  const participantRows = await db
    .select({
      id: tournamentParticipants.id,
      tournamentId: tournamentParticipants.tournamentId,
      playerId: tournamentParticipants.playerId,
      cleanedName: tournamentParticipants.cleanedName,
      seed: tournamentParticipants.challongeSeed,
      finalRank: tournamentParticipants.finalRank,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
      companyCode: companies.code,
    })
    .from(tournamentParticipants)
    .leftJoin(players, eq(tournamentParticipants.playerId, players.id))
    .leftJoin(companies, eq(players.companyId, companies.id))
    .where(inArray(tournamentParticipants.tournamentId, nightIds));

  const characters = await charactersByPlayer(
    db,
    participantRows.flatMap((p) => (p.playerId ? [p.playerId] : [])),
  );

  const participants: RecapParticipant[] = participantRows.map((p) => ({
    id: p.id,
    tournamentId: p.tournamentId,
    playerId: p.playerId,
    // Public surface, so a player with no chosen alias shows the short form.
    name: p.canonicalName
      ? publicPlayerName({ displayName: p.displayName, canonicalName: p.canonicalName })
      : p.cleanedName,
    companyCode: p.companyCode,
    characters: p.playerId ? (characters.get(p.playerId) ?? []) : [],
    seed: p.seed,
    finalRank: p.finalRank,
  }));

  // --- sets ---------------------------------------------------------------

  const setRows = await db
    .select()
    .from(sets)
    .where(inArray(sets.tournamentId, nightIds))
    .orderBy(asc(sets.suggestedPlayOrder), asc(sets.challongeMatchId));

  const recapSets: RecapSet[] = setRows.map((row) => ({
    id: row.id,
    tournamentId: row.tournamentId,
    round: row.round,
    suggestedPlayOrder: row.suggestedPlayOrder,
    identifier: row.identifier,
    state: row.state,
    p1ParticipantId: row.p1ParticipantId,
    p2ParticipantId: row.p2ParticipantId,
    winner: row.winner === 1 || row.winner === 2 ? row.winner : null,
    scoresCsv: row.scoresCsv,
    excludedFromRatings: row.excludedFromRatings,
    completedAt: row.completedAt?.toISOString() ?? null,
  }));

  // --- ratings (optional) -------------------------------------------------

  const recomputeId = await latestRecomputeId(db);
  const { nightEvents, history, rankMovement } = recomputeId
    ? await loadRatingContext(db, recomputeId, nightIds)
    : { nightEvents: [], history: undefined, rankMovement: [] };

  // --- turnout comparison -------------------------------------------------

  const priorTurnouts = await loadPriorTurnouts(db, allDated, anchorKey);

  const result = buildRecap({
    tournaments: nightTournaments,
    participants,
    sets: recapSets,
    ratingEvents: nightEvents,
    history,
    rankMovement,
    priorTurnouts,
  });

  // The engine orders brackets main-first, so the night's canonical slug — the
  // one a shared link should carry — is the first one back.
  const withSlugs = result.tournaments.map((t) => ({ ...t, slug: slugById.get(t.id) ?? slug }));
  return {
    ...result,
    tournaments: withSlugs,
    facts: result.facts.map((entry) => ({ ...entry, ...formatFact(entry.fact) })),
    slug: withSlugs[0]?.slug ?? slug,
  };
}

interface RatingContext {
  nightEvents: Array<{
    playerId: string;
    setId: string | null;
    tournamentId: string;
    isDecay: boolean;
    won: boolean | null;
    preRating: number;
    postRating: number;
    preRd: number;
    postRd: number;
  }>;
  history: RecapHistory | undefined;
  rankMovement: Array<{ playerId: string; rank: number; previousRank: number | null }>;
}

async function loadRatingContext(db: Db, recomputeId: string, nightIds: string[]): Promise<RatingContext> {
  const nightRows = await db
    .select({
      playerId: ratingEvents.playerId,
      setId: ratingEvents.setId,
      tournamentId: ratingEvents.tournamentId,
      seq: ratingEvents.seq,
      isDecay: ratingEvents.isDecay,
      won: ratingEvents.won,
      preRating: ratingEvents.preRating,
      postRating: ratingEvents.postRating,
      preRd: ratingEvents.preRd,
      postRd: ratingEvents.postRd,
    })
    .from(ratingEvents)
    .where(and(eq(ratingEvents.recomputeId, recomputeId), inArray(ratingEvents.tournamentId, nightIds)))
    .orderBy(asc(ratingEvents.seq));

  const nightEvents = nightRows.map(({ seq: _seq, ...event }) => event);

  // The night may not be in this recompute yet (it runs debounced), in which
  // case there is no rating context to build and the recap stays seed-based.
  if (nightRows.length === 0) return { nightEvents, history: undefined, rankMovement: [] };

  /*
   * Everything the replay processed before this night's first event. Using
   * `seq` rather than a date is what makes this exact: it is the same ordering
   * the ratings were computed in, so "before" here means the same thing it
   * meant to the engine.
   */
  const firstSeq = nightRows[0]!.seq;
  const priorRows = await db
    .select({
      playerId: ratingEvents.playerId,
      opponentPlayerId: ratingEvents.opponentPlayerId,
      tournamentId: ratingEvents.tournamentId,
      isDecay: ratingEvents.isDecay,
      won: ratingEvents.won,
      postRating: ratingEvents.postRating,
    })
    .from(ratingEvents)
    .where(and(eq(ratingEvents.recomputeId, recomputeId), lt(ratingEvents.seq, firstSeq)))
    .orderBy(asc(ratingEvents.seq));

  const priorTournamentIds = new Set(priorRows.map((row) => row.tournamentId));
  const tournamentDates =
    priorTournamentIds.size > 0
      ? await db
          .select({ id: tournaments.id, eventDate: tournaments.eventDate })
          .from(tournaments)
          .where(inArray(tournaments.id, [...priorTournamentIds]))
      : [];
  const eventKeyByTournament = new Map(
    tournamentDates.map((t) => [t.id, t.eventDate ? eventKeyOf(t.eventDate.toISOString()) : t.id]),
  );

  const priorSetCounts = new Map<string, number>();
  const priorPeakRating = new Map<string, number>();
  const priorMeetings = new Map<string, { aWins: number; bWins: number }>();
  const nightsByPlayer = new Map<string, Set<string>>();

  for (const row of priorRows) {
    // Peaks count decay events too — decay moves RD, not the rating, so it
    // cannot manufacture a peak, and skipping them would drop the tail of an
    // inactive player's history for no reason.
    const peak = priorPeakRating.get(row.playerId);
    if (peak === undefined || row.postRating > peak) priorPeakRating.set(row.playerId, row.postRating);
    if (row.isDecay) continue;

    priorSetCounts.set(row.playerId, (priorSetCounts.get(row.playerId) ?? 0) + 1);

    const nights = nightsByPlayer.get(row.playerId) ?? new Set<string>();
    nights.add(eventKeyByTournament.get(row.tournamentId) ?? row.tournamentId);
    nightsByPlayer.set(row.playerId, nights);

    /*
     * A set produces one rating event per player, so counting a meeting from
     * both sides would double it. Count only the winner's row — `won` is null
     * only for decay, already skipped above.
     */
    if (row.won !== true || !row.opponentPlayerId) continue;
    const key = pairKey(row.playerId, row.opponentPlayerId);
    const record = priorMeetings.get(key) ?? { aWins: 0, bWins: 0 };
    // `aWins` belongs to the lexicographically smaller id, matching `pairKey`.
    if (row.playerId < row.opponentPlayerId) record.aWins += 1;
    else record.bWins += 1;
    priorMeetings.set(key, record);
  }

  const priorEventCounts = new Map<string, number>(
    [...nightsByPlayer].map(([playerId, nights]) => [playerId, nights.size]),
  );

  const rankMovement = await db
    .select({
      playerId: playerRatings.playerId,
      rank: playerRatings.rank,
      previousRank: playerRatings.previousRank,
    })
    .from(playerRatings)
    .where(eq(playerRatings.recomputeId, recomputeId));

  return {
    nightEvents,
    history: { priorSetCounts, priorEventCounts, priorPeakRating, priorMeetings },
    rankMovement,
  };
}

/**
 * Entrants per earlier night, for the turnout comparison. Someone who entered
 * both brackets of a night is one entrant, matching how the engine counts
 * tonight's.
 */
async function loadPriorTurnouts(
  db: Db,
  allDated: Array<{ id: string; eventDate: Date | null }>,
  anchorKey: string | null,
): Promise<Array<{ eventKey: string; entrants: number }>> {
  if (anchorKey === null) return [];
  const earlier = allDated.filter(
    (t) => t.eventDate !== null && eventKeyOf(t.eventDate.toISOString()) < anchorKey,
  );
  if (earlier.length === 0) return [];

  const rows = await db
    .select({
      tournamentId: tournamentParticipants.tournamentId,
      participantId: tournamentParticipants.id,
      playerId: tournamentParticipants.playerId,
    })
    .from(tournamentParticipants)
    .where(
      inArray(
        tournamentParticipants.tournamentId,
        earlier.map((t) => t.id),
      ),
    );

  const keyByTournament = new Map(
    earlier.map((t) => [t.id, eventKeyOf(t.eventDate!.toISOString())]),
  );
  // Unresolved entries have no player id to dedupe on, so they count as
  // themselves — the same rule the engine applies to tonight.
  const byNight = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = keyByTournament.get(row.tournamentId);
    if (!key) continue;
    const seen = byNight.get(key) ?? new Set<string>();
    seen.add(row.playerId ?? `unresolved:${row.participantId}`);
    byNight.set(key, seen);
  }
  return [...byNight].map(([eventKey, seen]) => ({ eventKey, entrants: seen.size }));
}
