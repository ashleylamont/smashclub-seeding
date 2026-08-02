import { and, eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { sets, syncJobs, tournamentParticipants, tournaments } from '@smashclub/db';
import { scoresIndicateUnplayed, type ChallongeMatch } from '@smashclub/engine';
import type { ChallongeClient } from '../challonge/client';
import { recomputePendingCandidates } from '../identity/candidates';
import { matchTournamentParticipants } from '../identity/matching';
import { liveBus } from '../live/bus';
import { markDraftRunsStale } from '../seeding/seeding';

export interface SyncResult {
  tournamentId: string;
  participantsUpserted: number;
  setsUpserted: number;
  setsChanged: number;
  queuedForReview: number;
  challongeState: string;
}

/**
 * Full sync of one registered tournament: fetch from Challonge, idempotently
 * upsert participants and sets (keyed by their Challonge IDs), run the
 * identity pipeline for unresolved participants, and denormalise resolved
 * player IDs onto sets. Safe to run repeatedly; score amendments and DQ
 * changes upstream flow through.
 */
export interface SyncOptions {
  /**
   * `public` (THE DEFAULT) reads the unauthenticated, unmetered bracket page
   * and never touches the API.
   *
   * `api` uses the authenticated Challonge API, falling back to the public
   * bracket when the tournament is outside the account. It is opt-in per sync
   * and deliberately NOT a fallback: Challonge's free tier allows 500 requests
   * per MONTH, and an automatic fallback would quietly spend that allowance
   * every time the public path had a bad day.
   *
   * The API is worth spending on for a tournament the club owns, because it is
   * the only source of `final_rank` (placements). Everything the ratings engine
   * needs — participants, matches, winners, scores, seeds — is in the public
   * bracket.
   */
  source?: 'api' | 'public';
}

export async function syncTournament(
  db: Db,
  client: ChallongeClient,
  tournamentId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
  if (!tournament) throw new Error(`Unknown tournament ${tournamentId}`);

  const [job] = await db
    .insert(syncJobs)
    .values({ type: 'tournament_sync', tournamentId })
    .returning({ id: syncJobs.id });

  try {
    await db.update(tournaments).set({ syncState: 'syncing', updatedAt: new Date() }).where(eq(tournaments.id, tournamentId));

    const bundle =
      options.source === 'api'
        ? await client.fetchTournamentBundle(tournament.challongeSlug)
        : await client.fetchPublicTournamentBundle(tournament.challongeSlug);

    const eventDate = tournament.eventDateManual
      ? tournament.eventDate
      : parseDate(bundle.tournament.startedAt ?? bundle.tournament.completedAt ?? bundle.tournament.updatedAt) ??
        tournament.eventDate;

    await db
      .update(tournaments)
      .set({
        challongeId: bundle.tournament.id || tournament.challongeId,
        name: bundle.tournament.name || tournament.name,
        eventDate,
        challongeState: bundle.tournament.state,
        raw: bundle.tournament as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(tournaments.id, tournamentId));

    // --- participants ---
    const beforeCount = (
      await db
        .select({ id: tournamentParticipants.id })
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, tournamentId))
    ).length;
    let participantsUpserted = 0;
    for (const participant of bundle.participants) {
      await db
        .insert(tournamentParticipants)
        .values({
          tournamentId,
          challongeParticipantId: participant.id,
          rawName: participant.displayName,
          cleanedName: participant.displayName,
          challongeSeed: participant.seed,
          finalRank: participant.finalRank,
        })
        .onConflictDoUpdate({
          target: [tournamentParticipants.tournamentId, tournamentParticipants.challongeParticipantId],
          set: {
            rawName: participant.displayName,
            challongeSeed: participant.seed,
            // The public bracket carries no final_rank, so a public sync must
            // not blank a placement an API sync previously recorded. Absent
            // means "unknown here", not "cleared".
            ...(participant.finalRank !== null ? { finalRank: participant.finalRank } : {}),
            updatedAt: new Date(),
          },
        });
      participantsUpserted += 1;
    }

    const participantRows = await db
      .select({
        id: tournamentParticipants.id,
        challongeParticipantId: tournamentParticipants.challongeParticipantId,
      })
      .from(tournamentParticipants)
      .where(eq(tournamentParticipants.tournamentId, tournamentId));
    const participantIdByChallongeId = new Map(participantRows.map((row) => [row.challongeParticipantId, row.id]));
    if (participantRows.length !== beforeCount) {
      // Roster changed: any draft seeding run no longer reflects reality.
      await markDraftRunsStale(db, tournamentId);
    }

    // --- sets ---
    let setsUpserted = 0;
    let setsChanged = 0;
    for (const match of bundle.matches) {
      const values = buildSetValues(tournamentId, match, participantIdByChallongeId);
      const existing = await db
        .select()
        .from(sets)
        .where(and(eq(sets.tournamentId, tournamentId), eq(sets.challongeMatchId, match.id)));
      const current = existing[0];
      if (!current) {
        await db.insert(sets).values(values);
        setsUpserted += 1;
        setsChanged += 1;
        continue;
      }
      const changed =
        current.state !== values.state ||
        current.winner !== values.winner ||
        current.scoresCsv !== values.scoresCsv ||
        current.round !== values.round ||
        current.suggestedPlayOrder !== values.suggestedPlayOrder ||
        (current.completedAt?.getTime() ?? null) !== (values.completedAt?.getTime() ?? null) ||
        /*
         * Upstream can be byte-identical and our verdict on it still change,
         * because the rule that reads it lives here: when byes joined forfeits
         * as "not a played set", every stored `99-0` needed re-judging. Without
         * this the fix would only have reached sets Challonge happened to touch
         * again. An admin's manual override is still respected below.
         */
        (!current.exclusionManual && current.excludedFromRatings !== values.excludedFromRatings);
      if (changed) {
        await db
          .update(sets)
          .set({
            ...values,
            // Respect an admin's manual exclusion override.
            excludedFromRatings: current.exclusionManual ? current.excludedFromRatings : values.excludedFromRatings,
            exclusionManual: current.exclusionManual,
            updatedAt: new Date(),
          })
          .where(eq(sets.id, current.id));
        setsChanged += 1;
      }
      setsUpserted += 1;
    }

    // --- identity resolution + denormalisation ---
    const outcomes = await matchTournamentParticipants(db, tournamentId);
    const queuedForReview = outcomes.filter((o) => o.method === 'queued').length;
    // Refresh the older items' candidate snapshots too, but only when this sync
    // actually had identities to resolve — a live poll of a settled bracket
    // should stay a no-op. No Challonge traffic either way: this reads players
    // out of Postgres.
    if (outcomes.length > 0) await recomputePendingCandidates(db);

    /*
     * `sync_state` answers ONE question: have we pulled this bracket's results
     * in? We just did, so it is `synced` — whatever Challonge thinks of the
     * bracket itself.
     *
     * It used to fall back to `registered` for anything not `complete`
     * upstream, which conflated our pipeline's state with Challonge's. A
     * bracket the room never closed showed "Not synced yet" on a page listing
     * all 85 of its synced sets. Whether the bracket has finished is
     * `challonge_state`'s business, and the scheduler decides what to re-poll
     * from that (see `sweep`) rather than from this column.
     *
     * `underway` still deliberately does not map to a `live` sync state:
     * Challonge's `underway` is sticky — tournaments abandoned years ago report
     * it — so deriving liveness from it meant polling dead brackets forever,
     * exhausting the free tier's 500 requests/month in about 40 minutes.
     * Liveness is an explicit, expiring admin decision (`tournaments.live_until`).
     */
    const syncState = 'synced';
    // A finished bracket ends live monitoring immediately, without waiting for
    // the window to expire.
    const liveUntil = bundle.tournament.state === 'complete' ? null : tournament.liveUntil;
    await db
      .update(tournaments)
      .set({ syncState, liveUntil, lastSyncedAt: new Date(), syncError: null, updatedAt: new Date() })
      .where(eq(tournaments.id, tournamentId));

    const result: SyncResult = {
      tournamentId,
      participantsUpserted,
      setsUpserted,
      setsChanged,
      queuedForReview,
      challongeState: bundle.tournament.state,
    };
    await db
      .update(syncJobs)
      .set({ status: 'complete', finishedAt: new Date(), stats: result as unknown as Record<string, unknown> })
      .where(eq(syncJobs.id, job!.id));
    if (setsChanged > 0) {
      liveBus.publish({ type: 'set_updated', tournamentId, payload: { setsChanged } });
    }
    liveBus.publish({ type: 'sync_completed', tournamentId, payload: result });
    return result;
  } catch (error) {
    await db
      .update(syncJobs)
      .set({ status: 'failed', finishedAt: new Date(), error: String(error) })
      .where(eq(syncJobs.id, job!.id));
    await db
      .update(tournaments)
      .set({ syncState: 'error', syncError: String(error), updatedAt: new Date() })
      .where(eq(tournaments.id, tournamentId));
    throw error;
  }
}

function buildSetValues(
  tournamentId: string,
  match: ChallongeMatch,
  participantIdByChallongeId: Map<number, string>,
) {
  const winner =
    match.winnerId !== null && match.player1Id !== null && match.winnerId === match.player1Id
      ? 1
      : match.winnerId !== null && match.player2Id !== null && match.winnerId === match.player2Id
        ? 2
        : null;
  return {
    tournamentId,
    challongeMatchId: match.id,
    round: match.round,
    suggestedPlayOrder: match.suggestedPlayOrder,
    identifier: match.identifier,
    state: match.state,
    p1ParticipantId: match.player1Id !== null ? (participantIdByChallongeId.get(match.player1Id) ?? null) : null,
    p2ParticipantId: match.player2Id !== null ? (participantIdByChallongeId.get(match.player2Id) ?? null) : null,
    winner,
    scoresCsv: match.scoresCsv,
    excludedFromRatings: scoresIndicateUnplayed(match.scoresCsv),
    completedAt: parseDate(match.completedAt),
    raw: match as unknown as Record<string, unknown>,
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
