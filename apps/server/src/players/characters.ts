import { z } from 'zod';
import { inArray, eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { playerCharacters } from '@smashclub/db';
import { MAX_CHARACTERS_PER_PLAYER, isCharacterSlug } from '@smashclub/shared';

/**
 * A player's mains. Stored as ordered rows so the first slug is *the* main and
 * the icon strip renders in the order the player chose.
 */

/**
 * Input schema for a character list. Validating against the shared roster here
 * — rather than with a DB constraint — keeps a new DLC fighter a one-line
 * change to the roster instead of a migration.
 */
export const characterSlugsSchema = z
  .array(z.string())
  .max(MAX_CHARACTERS_PER_PLAYER)
  .refine((slugs) => slugs.every(isCharacterSlug), { message: 'Unknown character.' })
  .refine((slugs) => new Set(slugs).size === slugs.length, { message: 'Duplicate character.' });

/**
 * Replace a player's characters with `slugs`, in order. A full replace rather
 * than a diff: the picker always submits the complete list, and this way
 * removing the last character actually clears the row set.
 */
export async function setPlayerCharacters(db: Db, playerId: string, slugs: string[]): Promise<void> {
  await db.delete(playerCharacters).where(eq(playerCharacters.playerId, playerId));
  if (slugs.length === 0) return;
  await db.insert(playerCharacters).values(
    slugs.map((slug, index) => ({ playerId, characterSlug: slug, position: index })),
  );
}

/**
 * Characters for many players at once, keyed by player id and in display
 * order. Callers that list players (leaderboard, registry) use this instead of
 * a per-row query.
 */
export async function charactersByPlayer(db: Db, playerIds?: string[]): Promise<Map<string, string[]>> {
  if (playerIds && playerIds.length === 0) return new Map();
  const rows = playerIds
    ? await db.select().from(playerCharacters).where(inArray(playerCharacters.playerId, playerIds))
    : await db.select().from(playerCharacters);

  const byPlayer = new Map<string, Array<{ slug: string; position: number }>>();
  for (const row of rows) {
    const list = byPlayer.get(row.playerId) ?? [];
    list.push({ slug: row.characterSlug, position: row.position });
    byPlayer.set(row.playerId, list);
  }
  return new Map(
    [...byPlayer].map(([playerId, list]) => [
      playerId,
      list.sort((a, b) => a.position - b.position).map((entry) => entry.slug),
    ]),
  );
}

/** Characters for a single player, in display order. */
export async function charactersForPlayer(db: Db, playerId: string): Promise<string[]> {
  const map = await charactersByPlayer(db, [playerId]);
  return map.get(playerId) ?? [];
}
