import { players, type Db } from '@smashclub/db';

/** Identity redirects apply to historical exports; the journal retains actual entrant IDs. */
export async function historicalPlayerIds(db: Db) {
  const rows = new Map((await db.select().from(players)).map((p) => [p.id, p]));
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
