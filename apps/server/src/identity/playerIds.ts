import { asc, inArray } from 'drizzle-orm';
import { players, type Db } from '@smashclub/db';

/** Identity redirects apply to historical exports; the journal retains actual entrant IDs. */
export async function historicalPlayerIds(db: Db) {
  return playerIdResolver(await db.select().from(players));
}

export function playerIdResolver(
  profiles: readonly Pick<typeof players.$inferSelect, 'id' | 'mergedIntoPlayerId'>[],
) {
  const rows = new Map(profiles.map((p) => [p.id, p]));
  return (id: string) => {
    const visited = new Set<string>();
    while (rows.get(id)?.mergedIntoPlayerId) {
      if (visited.has(id)) throw new Error('Player identity redirects contain a cycle.');
      visited.add(id);
      id = rows.get(id)!.mergedIntoPlayerId!;
    }
    return id;
  };
}

/** Call inside the writer's SQL transaction, before checking live membership.
 * Order competing writers by player ID and allow unrelated FK readers. */
export async function lockPlayerRows(tx: Db, ids: string[]) {
  return tx
    .select()
    .from(players)
    .where(inArray(players.id, ids))
    .orderBy(asc(players.id))
    .for('no key update');
}
