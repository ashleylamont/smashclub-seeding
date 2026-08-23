import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { playerAliases, reviewItems, sets, tournamentParticipants } from '@smashclub/db';
import { resolvePlayerInputs } from './resolver';

/**
 * The participant-identity pipeline, replacing the legacy CLI's blocking
 * prompts. The ladder it climbs per participant — clean, exact alias, prior
 * human decision, structured short form, else review — lives in
 * `identity/resolver.ts`, which is a pure read; this module is what turns that
 * answer into tournament writes.
 *
 * Steps 2-4 of that ladder all bind an upstream-controlled display name to an
 * internal player, so the strength of the evidence decides how *durable* the
 * result is allowed to be. An exact alias or a prior human decision is a club
 * record being recognised. A structured short form is only an inference from
 * the pool as it stands right now — "Josh C" is Josh Cortese because today he
 * is the only matching Josh — so it links this participant and stops there.
 * Writing it into player_aliases would freeze a guess into a club record and
 * keep resolving it silently even once a second Josh C. makes it ambiguous;
 * left unwritten, that later ambiguity correctly falls through to review.
 * Admins can still promote a short form deliberately via addAlias.
 */

export interface MatchOutcome {
  participantId: string;
  cleanedName: string;
  companyId: string | null;
  playerId: string | null;
  method: 'existing' | 'alias' | 'decision' | 'structured' | 'queued';
}

/**
 * Resolve identities for a tournament's unresolved participants. Writes
 * participant.playerId on auto-links and creates pending review items for the
 * rest. Returns the outcomes for observability/tests.
 */
export async function matchTournamentParticipants(db: Db, tournamentId: string): Promise<MatchOutcome[]> {
  const unresolved = await db
    .select()
    .from(tournamentParticipants)
    .where(and(eq(tournamentParticipants.tournamentId, tournamentId), isNull(tournamentParticipants.playerId)));
  if (unresolved.length === 0) return [];

  const resolutions = await resolvePlayerInputs(
    db,
    unresolved.map((participant) => participant.rawName),
  );
  const outcomes: MatchOutcome[] = [];

  for (const [index, participant] of unresolved.entries()) {
    const resolution = resolutions[index]!;
    const { cleanedName, companyId } = resolution;

    await db
      .update(tournamentParticipants)
      .set({ cleanedName, companyId, updatedAt: new Date() })
      .where(eq(tournamentParticipants.id, participant.id));

    if (resolution.playerId !== null && resolution.method !== 'unresolved') {
      await linkParticipant(db, participant.id, resolution.playerId);
      // A decision is a club record being recognised, so it is worth writing
      // back as an alias; a structured short form is an inference and
      // deliberately is not (see the module comment).
      if (resolution.method === 'decision') {
        await ensureAlias(db, resolution.playerId, cleanedName.toLowerCase(), companyId, 'merge_decision');
      }
      outcomes.push({
        participantId: participant.id,
        cleanedName,
        companyId,
        playerId: resolution.playerId,
        method: resolution.method,
      });
      continue;
    }

    // Review queue. The ranked list is a snapshot of the pool as it is right
    // now — see identity/candidates.ts for how it is kept current afterwards.
    const existingPending = await db
      .select({ id: reviewItems.id })
      .from(reviewItems)
      .where(and(eq(reviewItems.tournamentParticipantId, participant.id), eq(reviewItems.status, 'pending')));
    if (existingPending.length === 0) {
      await db.insert(reviewItems).values({
        tournamentParticipantId: participant.id,
        rawName: participant.rawName,
        cleanedName,
        companyId,
        candidates: resolution.candidates,
        candidatesComputedAt: new Date(),
      });
    }
    outcomes.push({
      participantId: participant.id,
      cleanedName,
      companyId,
      playerId: null,
      method: 'queued',
    });
  }

  await backfillSetPlayers(db, tournamentId);
  return outcomes;
}

async function linkParticipant(db: Db, participantId: string, playerId: string): Promise<void> {
  await db
    .update(tournamentParticipants)
    .set({ playerId, updatedAt: new Date() })
    .where(eq(tournamentParticipants.id, participantId));
}

export async function ensureAlias(
  db: Db,
  playerId: string,
  aliasNorm: string,
  companyId: string | null,
  source: 'registry' | 'challonge' | 'structured' | 'manual' | 'merge_decision',
): Promise<void> {
  await db
    .insert(playerAliases)
    .values({ playerId, aliasNorm, companyId, source })
    .onConflictDoNothing();
}

/** Denormalise participants' resolved player IDs onto their sets. */
export async function backfillSetPlayers(db: Db, tournamentId: string): Promise<void> {
  const participants = await db
    .select({ id: tournamentParticipants.id, playerId: tournamentParticipants.playerId })
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, tournamentId));
  const byId = new Map(participants.map((row) => [row.id, row.playerId]));

  const setRows = await db
    .select({
      id: sets.id,
      p1ParticipantId: sets.p1ParticipantId,
      p2ParticipantId: sets.p2ParticipantId,
      p1PlayerId: sets.p1PlayerId,
      p2PlayerId: sets.p2PlayerId,
    })
    .from(sets)
    .where(eq(sets.tournamentId, tournamentId));

  for (const row of setRows) {
    const p1 = row.p1ParticipantId ? (byId.get(row.p1ParticipantId) ?? null) : null;
    const p2 = row.p2ParticipantId ? (byId.get(row.p2ParticipantId) ?? null) : null;
    if (p1 !== row.p1PlayerId || p2 !== row.p2PlayerId) {
      await db.update(sets).set({ p1PlayerId: p1, p2PlayerId: p2, updatedAt: new Date() }).where(eq(sets.id, row.id));
    }
  }
}

/** Re-run backfill for every tournament a player appears in (post-merge). */
export async function backfillPlayerEverywhere(db: Db, playerIds: string[]): Promise<void> {
  if (playerIds.length === 0) return;
  const rows = await db
    .selectDistinct({ tournamentId: tournamentParticipants.tournamentId })
    .from(tournamentParticipants)
    .where(inArray(tournamentParticipants.playerId, playerIds));
  for (const row of rows) {
    await backfillSetPlayers(db, row.tournamentId);
  }
}
