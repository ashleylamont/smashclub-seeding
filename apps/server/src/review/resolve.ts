import { eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { identityDecisions, players, reviewItems, tournamentParticipants } from '@smashclub/db';
import { backfillSetPlayers, ensureAlias } from '../identity/matching';
import { setPlayerCharacters } from '../players/characters';

/**
 * Optional profile details captured when the reviewer mints a new player.
 * Every field is optional so the queue keeps its one-click rhythm: supplying
 * nothing reproduces the previous behaviour exactly.
 */
export interface NewPlayerDetails {
  /** Overrides the bracket's cleaned name as the registry name. */
  canonicalName?: string;
  /** Public-facing alias. */
  displayName?: string | null;
  /** Overrides the company detected from the bracket entry. */
  companyId?: string | null;
  characters?: string[];
}

export type ReviewResolutionInput =
  | { kind: 'linked_existing'; playerId: string }
  | { kind: 'created_new'; details?: NewPlayerDetails }
  | { kind: 'kept_separate'; details?: NewPlayerDetails };

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
    // The reviewer can now name any player, not only one of the ranked
    // candidates, so the target is no longer guaranteed to be a live player.
    const [target] = await db.select().from(players).where(eq(players.id, input.playerId));
    if (!target) throw new Error(`Unknown player ${input.playerId}`);
    if (target.status !== 'active') throw new Error(`Player ${target.canonicalName} is ${target.status}`);

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
    const details = input.details;
    const canonicalName = details?.canonicalName?.trim() || item.cleanedName;
    const companyId = details?.companyId !== undefined ? details.companyId : item.companyId;

    const [created] = await db
      .insert(players)
      .values({
        canonicalName,
        companyId,
        displayName: details?.displayName?.trim() || null,
      })
      .returning({ id: players.id });
    playerId = created!.id;

    // The bracket's own spelling is always aliased under the company it was
    // entered with, so the next import of that same entry matches silently —
    // even when the reviewer corrected the name or company on the way through.
    await ensureAlias(db, playerId, aliasNorm, item.companyId, 'challonge');
    const canonicalNorm = canonicalName.toLowerCase();
    if (canonicalNorm !== aliasNorm || companyId !== item.companyId) {
      await ensureAlias(db, playerId, canonicalNorm, companyId, 'manual');
    }
    if (details?.characters) await setPlayerCharacters(db, playerId, details.characters);

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
