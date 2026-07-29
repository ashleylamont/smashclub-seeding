import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import {
  identityDecisions,
  playerAliases,
  playerClaims,
  players,
  tournamentParticipants,
} from '@smashclub/db';
import { backfillPlayerEverywhere } from '../identity/matching';

/**
 * Merge player A into player B (admin action): A becomes a tombstone
 * pointing at B, aliases and participants move to B, live claims follow
 * with per-user dedupe, and affected sets are backfilled. Caller triggers a
 * recompute.
 */
export async function mergePlayers(db: Db, fromPlayerId: string, intoPlayerId: string): Promise<void> {
  if (fromPlayerId === intoPlayerId) throw new Error('Cannot merge a player into themselves.');
  const [from] = await db.select().from(players).where(eq(players.id, fromPlayerId));
  const [into] = await db.select().from(players).where(eq(players.id, intoPlayerId));
  if (!from || !into) throw new Error('Both players must exist.');
  if (from.status === 'merged') throw new Error(`${from.canonicalName} is already merged.`);
  if (into.status === 'merged') throw new Error(`Cannot merge into a tombstoned player.`);

  // Move aliases; drop those that would collide with an existing alias of B.
  const aliases = await db.select().from(playerAliases).where(eq(playerAliases.playerId, fromPlayerId));
  for (const alias of aliases) {
    const conflict = await db
      .select({ id: playerAliases.id })
      .from(playerAliases)
      .where(and(eq(playerAliases.aliasNorm, alias.aliasNorm), eq(playerAliases.playerId, intoPlayerId)));
    if (conflict.length > 0) {
      await db.delete(playerAliases).where(eq(playerAliases.id, alias.id));
    } else {
      await db
        .update(playerAliases)
        .set({ playerId: intoPlayerId, source: 'merge_decision', updatedAt: new Date() })
        .where(eq(playerAliases.id, alias.id));
    }
  }

  // The merged player's canonical name becomes an alias of the target.
  await db
    .insert(playerAliases)
    .values({
      playerId: intoPlayerId,
      aliasNorm: from.canonicalName.toLowerCase(),
      companyId: from.companyId,
      source: 'merge_decision',
    })
    .onConflictDoNothing();

  // Redirect merge decisions that pointed at A.
  await db
    .update(identityDecisions)
    .set({ playerId: intoPlayerId, updatedAt: new Date() })
    .where(eq(identityDecisions.playerId, fromPlayerId));

  // Move tournament participation.
  await db
    .update(tournamentParticipants)
    .set({ playerId: intoPlayerId, updatedAt: new Date() })
    .where(eq(tournamentParticipants.playerId, fromPlayerId));

  // Move live claims, deduping per user (one live claim per user invariant).
  const liveClaims = await db
    .select()
    .from(playerClaims)
    .where(and(eq(playerClaims.playerId, fromPlayerId), inArray(playerClaims.status, ['pending', 'approved'])));
  for (const claim of liveClaims) {
    const existing = await db
      .select({ id: playerClaims.id })
      .from(playerClaims)
      .where(
        and(
          eq(playerClaims.userId, claim.userId),
          eq(playerClaims.playerId, intoPlayerId),
          inArray(playerClaims.status, ['pending', 'approved']),
        ),
      );
    if (existing.length > 0) {
      await db
        .update(playerClaims)
        .set({ status: 'revoked', resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(playerClaims.id, claim.id));
    } else {
      await db
        .update(playerClaims)
        .set({ playerId: intoPlayerId, updatedAt: new Date() })
        .where(eq(playerClaims.id, claim.id));
    }
  }

  // Tombstone A.
  await db
    .update(players)
    .set({ status: 'merged', mergedIntoPlayerId: intoPlayerId, updatedAt: new Date() })
    .where(eq(players.id, fromPlayerId));

  await backfillPlayerEverywhere(db, [intoPlayerId]);
}
