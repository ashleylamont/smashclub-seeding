import { eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { identityDecisions, players, reviewItems, tournamentParticipants } from '@smashclub/db';
import { backfillSetPlayers, ensureAlias } from '../identity/matching';

export type ReviewResolutionInput =
  | { kind: 'linked_existing'; playerId: string }
  | { kind: 'created_new' }
  | { kind: 'kept_separate' };

/**
 * Resolve a pending review item. Every resolution links the participant to a
 * player (existing or newly created), records a durable identity decision so
 * the same question is never asked again, and backfills the player onto the
 * tournament's sets. The caller triggers a recompute afterwards.
 */
export async function resolveReviewItem(
  db: Db,
  reviewItemId: string,
  input: ReviewResolutionInput,
  resolvedBy: string | null,
): Promise<{ playerId: string }> {
  const [item] = await db.select().from(reviewItems).where(eq(reviewItems.id, reviewItemId));
  if (!item) throw new Error(`Unknown review item ${reviewItemId}`);
  if (item.status !== 'pending') throw new Error(`Review item ${reviewItemId} is already ${item.status}`);

  const [participant] = await db
    .select()
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.id, item.tournamentParticipantId));
  if (!participant) throw new Error(`Review item ${reviewItemId} has no participant`);

  const aliasNorm = item.cleanedName.toLowerCase();
  let playerId: string;

  if (input.kind === 'linked_existing') {
    playerId = input.playerId;
    await ensureAlias(db, playerId, aliasNorm, item.companyId, 'manual');
    await db
      .insert(identityDecisions)
      .values({ kind: 'merge', aliasNorm, companyId: item.companyId, playerId, decidedBy: resolvedBy })
      .onConflictDoNothing();
  } else {
    // created_new and kept_separate both mint a new player; kept_separate
    // additionally records rejections against the offered candidates so the
    // pair is never suggested again.
    const [created] = await db
      .insert(players)
      .values({ canonicalName: item.cleanedName, companyId: item.companyId })
      .returning({ id: players.id });
    playerId = created!.id;
    await ensureAlias(db, playerId, aliasNorm, item.companyId, 'challonge');

    if (input.kind === 'kept_separate') {
      const candidates = (item.candidates as Array<{ playerId: string }> | null) ?? [];
      for (const candidate of candidates) {
        await db
          .insert(identityDecisions)
          .values({
            kind: 'keep_separate',
            aliasNorm,
            companyId: item.companyId,
            keptSeparateFromPlayerId: candidate.playerId,
            decidedBy: resolvedBy,
          })
          .onConflictDoNothing();
      }
    }
  }

  await db
    .update(tournamentParticipants)
    .set({ playerId, updatedAt: new Date() })
    .where(eq(tournamentParticipants.id, participant.id));
  await db
    .update(reviewItems)
    .set({
      status: 'resolved',
      resolution: input.kind,
      resolvedPlayerId: playerId,
      resolvedBy,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(reviewItems.id, reviewItemId));

  await backfillSetPlayers(db, participant.tournamentId);
  return { playerId };
}
