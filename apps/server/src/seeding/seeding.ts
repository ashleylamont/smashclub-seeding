import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import {
  playerRatings,
  players,
  seedingEntries,
  seedingRuns,
  syncJobs,
  tournamentParticipants,
  tournaments,
} from '@smashclub/db';
import type { ChallongeClient } from '../challonge/client';
import { latestRecomputeId } from '../recompute/recompute';

/**
 * Seeding workbench backend. A run snapshots auto-seeds from the current
 * leaderboard; admins reorder/lock entries; pushing writes seeds back to
 * Challonge sequentially and verifies by re-fetching.
 */

export async function createSeedingRun(db: Db, tournamentId: string, createdBy: string | null): Promise<string> {
  const recomputeId = await latestRecomputeId(db);
  const participants = await db
    .select({
      id: tournamentParticipants.id,
      playerId: tournamentParticipants.playerId,
      cleanedName: tournamentParticipants.cleanedName,
    })
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, tournamentId));
  if (participants.length === 0) {
    // Seeding happens BEFORE an event starts, and the public bracket derives its
    // participant list from matches — which do not exist yet, and which Challonge
    // only sometimes pre-generates. The roster is therefore only reliably
    // available from the API, making seeding one of the few flows worth spending
    // the metered allowance on.
    throw new Error(
      'Tournament has no participants to seed. Press "Sync (API)" first — the free public ' +
        'bracket carries no roster until matches exist.',
    );
  }

  const ratingByPlayer = new Map<string, { conservativeRating: number; rating: number; rd: number }>();
  if (recomputeId) {
    const ratingRows = await db.select().from(playerRatings).where(eq(playerRatings.recomputeId, recomputeId));
    for (const row of ratingRows) {
      ratingByPlayer.set(row.playerId, {
        conservativeRating: row.conservativeRating,
        rating: row.rating,
        rd: row.rd,
      });
    }
  }

  // Rated players by conservative score; unrated (incl. unresolved) players
  // sink to the bottom alphabetically — the legacy "no history last" rule.
  const ordered = [...participants].sort((a, b) => {
    const ratingA = a.playerId ? ratingByPlayer.get(a.playerId) : undefined;
    const ratingB = b.playerId ? ratingByPlayer.get(b.playerId) : undefined;
    if (ratingA && ratingB) {
      return (
        ratingB.conservativeRating - ratingA.conservativeRating ||
        ratingB.rating - ratingA.rating ||
        ratingA.rd - ratingB.rd ||
        a.cleanedName.localeCompare(b.cleanedName)
      );
    }
    if (ratingA) return -1;
    if (ratingB) return 1;
    return a.cleanedName.localeCompare(b.cleanedName);
  });

  const [run] = await db
    .insert(seedingRuns)
    .values({ tournamentId, recomputeId, createdBy })
    .returning({ id: seedingRuns.id });
  await db.insert(seedingEntries).values(
    ordered.map((participant, index) => ({
      runId: run!.id,
      participantId: participant.id,
      playerId: participant.playerId,
      autoScore: participant.playerId ? (ratingByPlayer.get(participant.playerId)?.conservativeRating ?? null) : null,
      autoSeed: index + 1,
    })),
  );
  return run!.id;
}

/** Replace the run's manual order: participantIds in final seed order. */
export async function reorderSeedingRun(db: Db, runId: string, participantIdsInOrder: string[]): Promise<void> {
  const entries = await db.select().from(seedingEntries).where(eq(seedingEntries.runId, runId));
  const byParticipant = new Map(entries.map((entry) => [entry.participantId, entry]));
  if (participantIdsInOrder.length !== entries.length) {
    throw new Error(`Expected ${entries.length} participants, got ${participantIdsInOrder.length}.`);
  }
  for (const [index, participantId] of participantIdsInOrder.entries()) {
    const entry = byParticipant.get(participantId);
    if (!entry) throw new Error(`Participant ${participantId} is not part of this run.`);
    const overrideSeed = index + 1;
    await db
      .update(seedingEntries)
      .set({ overrideSeed: overrideSeed === entry.autoSeed ? null : overrideSeed, updatedAt: new Date() })
      .where(eq(seedingEntries.id, entry.id));
  }
}

export async function setEntryLocked(db: Db, entryId: string, locked: boolean): Promise<void> {
  await db.update(seedingEntries).set({ locked, updatedAt: new Date() }).where(eq(seedingEntries.id, entryId));
}

export interface SeedPushResult {
  pushed: number;
  verified: boolean;
  log: Array<{ participantId: string; challongeParticipantId: number; seed: number; ok: boolean; error?: string }>;
}

export async function pushSeedingRun(db: Db, client: ChallongeClient, runId: string): Promise<SeedPushResult> {
  const [run] = await db.select().from(seedingRuns).where(eq(seedingRuns.id, runId));
  if (!run) throw new Error(`Unknown seeding run ${runId}`);
  if (run.status === 'pushed') throw new Error('This run has already been pushed.');
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, run.tournamentId));
  if (!tournament) throw new Error('Seeding run tournament no longer exists.');

  const entries = await db.select().from(seedingEntries).where(eq(seedingEntries.runId, runId));
  const participants = await db
    .select()
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, run.tournamentId));
  const participantById = new Map(participants.map((p) => [p.id, p]));

  const finalOrder = [...entries].sort(
    (a, b) => (a.overrideSeed ?? a.autoSeed) - (b.overrideSeed ?? b.autoSeed) || a.autoSeed - b.autoSeed,
  );

  const [job] = await db
    .insert(syncJobs)
    .values({ type: 'seed_push', tournamentId: run.tournamentId })
    .returning({ id: syncJobs.id });

  const log: SeedPushResult['log'] = [];
  try {
    for (const [index, entry] of finalOrder.entries()) {
      const participant = participantById.get(entry.participantId);
      const seed = index + 1;
      if (!participant) {
        log.push({ participantId: entry.participantId, challongeParticipantId: -1, seed, ok: false, error: 'participant missing' });
        continue;
      }
      try {
        await client.updateParticipantSeed(tournament.challongeSlug, participant.challongeParticipantId, seed);
        log.push({ participantId: entry.participantId, challongeParticipantId: participant.challongeParticipantId, seed, ok: true });
      } catch (error) {
        log.push({
          participantId: entry.participantId,
          challongeParticipantId: participant.challongeParticipantId,
          seed,
          ok: false,
          error: String(error),
        });
      }
    }

    // Verify by re-fetching participants and comparing seeds.
    const bundle = await client.fetchTournamentBundle(tournament.challongeSlug);
    const seedByChallongeId = new Map(bundle.participants.map((p) => [p.id, p.seed]));
    let verified = true;
    for (const [index, entry] of finalOrder.entries()) {
      const participant = participantById.get(entry.participantId);
      if (!participant) continue;
      if (seedByChallongeId.get(participant.challongeParticipantId) !== index + 1) verified = false;
    }

    const pushedOk = log.every((row) => row.ok);
    await db
      .update(seedingRuns)
      .set({
        status: pushedOk ? 'pushed' : 'draft',
        pushedAt: pushedOk ? new Date() : null,
        pushLog: { log, verified },
        updatedAt: new Date(),
      })
      .where(eq(seedingRuns.id, runId));
    await db
      .update(syncJobs)
      .set({ status: pushedOk ? 'complete' : 'failed', finishedAt: new Date(), stats: { log, verified } })
      .where(eq(syncJobs.id, job!.id));

    return { pushed: log.filter((row) => row.ok).length, verified, log };
  } catch (error) {
    await db
      .update(syncJobs)
      .set({ status: 'failed', finishedAt: new Date(), error: String(error) })
      .where(eq(syncJobs.id, job!.id));
    throw error;
  }
}

/** Mark draft runs stale when the participant list changes (called by sync). */
export async function markDraftRunsStale(db: Db, tournamentId: string): Promise<void> {
  await db
    .update(seedingRuns)
    .set({ status: 'stale', updatedAt: new Date() })
    .where(and(eq(seedingRuns.tournamentId, tournamentId), eq(seedingRuns.status, 'draft')));
}

export async function latestSeedingRun(db: Db, tournamentId: string) {
  const [run] = await db
    .select()
    .from(seedingRuns)
    .where(eq(seedingRuns.tournamentId, tournamentId))
    .orderBy(desc(seedingRuns.createdAt))
    .limit(1);
  if (!run) return null;
  const entries = await db
    .select({
      id: seedingEntries.id,
      participantId: seedingEntries.participantId,
      playerId: seedingEntries.playerId,
      autoScore: seedingEntries.autoScore,
      autoSeed: seedingEntries.autoSeed,
      overrideSeed: seedingEntries.overrideSeed,
      locked: seedingEntries.locked,
      rawName: tournamentParticipants.rawName,
      cleanedName: tournamentParticipants.cleanedName,
      challongeSeed: tournamentParticipants.challongeSeed,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
    })
    .from(seedingEntries)
    .innerJoin(tournamentParticipants, eq(seedingEntries.participantId, tournamentParticipants.id))
    .leftJoin(players, eq(seedingEntries.playerId, players.id))
    .where(eq(seedingEntries.runId, run.id));
  entries.sort((a, b) => (a.overrideSeed ?? a.autoSeed) - (b.overrideSeed ?? b.autoSeed) || a.autoSeed - b.autoSeed);
  return { run, entries };
}
