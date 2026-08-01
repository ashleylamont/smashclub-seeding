import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { companies, identityDecisions, playerAliases, players, reviewItems } from '@smashclub/db';
import { rankReviewCandidates } from '@smashclub/engine';

/**
 * Review-queue candidate scoring, split out of the sync-time matching pipeline
 * so it can be re-run for items that already exist.
 *
 * `review_items.candidates` is a snapshot: it is scored once, when sync queues
 * the item, against the players that existed at that moment. Every player
 * created, renamed, aliased or merged afterwards was invisible to every open
 * item — an item for "Anthy" kept reporting "no candidates" after an admin had
 * just created a player called Anthy. Regenerating the snapshot is what this
 * module is for; it never touches resolved or dismissed items, so a human
 * decision (including "keep separate") always outlives a recompute.
 *
 * Nothing here talks to Challonge — it reads players and review items out of
 * Postgres and writes the ranked list back.
 */

export interface ReviewCandidateSnapshot {
  playerId: string;
  name: string;
  companyCode: string | null;
  score: number;
  reason: 'fuzzy' | 'structured' | 'name-shape';
  /**
   * Set when the score came from one of the player's aliases rather than their
   * registry name, so the queue can say *why* an apparently unrelated name is
   * being offered.
   */
  matchedAlias: string | null;
}

export interface CandidatePlayer {
  name: string;
  companyCode: string | null;
  /** Every other spelling the player already answers to (`alias_norm`). */
  aliases: string[];
  playerId: string;
}

/**
 * Active players, the only things a review item may be linked to, each carrying
 * the aliases they already answer to. Matching a bracket entry against the
 * aliases as well as the registry name is what lets a player who enters as
 * "starfox" be offered for "starfoxx" — scoring the canonical name alone was
 * blind to every spelling the club had already taught the system.
 */
export async function loadCandidatePool(db: Db): Promise<CandidatePlayer[]> {
  const rows = await db
    .select({
      id: players.id,
      canonicalName: players.canonicalName,
      companyCode: companies.code,
    })
    .from(players)
    .leftJoin(companies, eq(players.companyId, companies.id))
    .where(eq(players.status, 'active'));

  const aliasRows = await db
    .select({ playerId: playerAliases.playerId, aliasNorm: playerAliases.aliasNorm })
    .from(playerAliases)
    .innerJoin(players, eq(playerAliases.playerId, players.id))
    .where(eq(players.status, 'active'));
  const aliasesByPlayer = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = aliasesByPlayer.get(row.playerId) ?? [];
    list.push(row.aliasNorm);
    aliasesByPlayer.set(row.playerId, list);
  }

  return rows.map((row) => ({
    name: row.canonicalName,
    companyCode: row.companyCode ?? null,
    aliases: aliasesByPlayer.get(row.id) ?? [],
    playerId: row.id,
  }));
}

/**
 * Rank the pool for one name. Pure: rejected pairs (`keep_separate`) are
 * filtered out here rather than in the engine, so a settled question is never
 * re-asked — not even by a recompute.
 */
export function scoreCandidates(
  cleanedName: string,
  companyCode: string | null,
  pool: readonly CandidatePlayer[],
  rejectedPlayerIds: ReadonlySet<string> = new Set(),
): ReviewCandidateSnapshot[] {
  return rankReviewCandidates(cleanedName, companyCode, pool)
    .filter((entry) => !rejectedPlayerIds.has(entry.candidate.playerId))
    .map((entry) => ({
      playerId: entry.candidate.playerId,
      name: entry.candidate.name,
      companyCode: entry.candidate.companyCode,
      score: entry.score,
      reason: entry.reason,
      matchedAlias:
        entry.matchedName.toLowerCase() === entry.candidate.name.toLowerCase() ? null : entry.matchedName,
    }));
}

/** Players a given alias has explicitly been kept separate from. */
export async function rejectedPlayerIdsFor(db: Db, aliasNorm: string): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(identityDecisions)
    .where(and(eq(identityDecisions.aliasNorm, aliasNorm), eq(identityDecisions.kind, 'keep_separate')));
  return new Set(rows.map((row) => row.keptSeparateFromPlayerId).filter((id): id is string => id !== null));
}

export interface RecomputeCandidatesResult {
  /** Pending items considered. */
  scanned: number;
  /** Items whose ranked list actually changed. */
  changed: number;
}

/**
 * Re-score the candidate snapshot of every pending review item (or just the
 * ones named). Cheap by construction: one pass over the player pool in memory,
 * a single timestamp update for the scanned rows, and a write only for the
 * items whose list actually moved. Resolved and dismissed items are never
 * touched.
 */
export async function recomputePendingCandidates(
  db: Db,
  options: { reviewItemIds?: string[] } = {},
): Promise<RecomputeCandidatesResult> {
  const { reviewItemIds } = options;
  if (reviewItemIds && reviewItemIds.length === 0) return { scanned: 0, changed: 0 };

  const items = await db
    .select({
      id: reviewItems.id,
      cleanedName: reviewItems.cleanedName,
      candidates: reviewItems.candidates,
      companyCode: companies.code,
    })
    .from(reviewItems)
    .leftJoin(companies, eq(reviewItems.companyId, companies.id))
    .where(
      and(
        eq(reviewItems.status, 'pending'),
        reviewItemIds ? inArray(reviewItems.id, reviewItemIds) : undefined,
      ),
    );
  if (items.length === 0) return { scanned: 0, changed: 0 };

  const pool = await loadCandidatePool(db);
  const aliasNorms = [...new Set(items.map((item) => item.cleanedName.toLowerCase()))];
  const rejections = await db
    .select()
    .from(identityDecisions)
    .where(and(eq(identityDecisions.kind, 'keep_separate'), inArray(identityDecisions.aliasNorm, aliasNorms)));
  const rejectedByAlias = new Map<string, Set<string>>();
  for (const row of rejections) {
    if (!row.keptSeparateFromPlayerId) continue;
    const set = rejectedByAlias.get(row.aliasNorm) ?? new Set<string>();
    set.add(row.keptSeparateFromPlayerId);
    rejectedByAlias.set(row.aliasNorm, set);
  }

  const now = new Date();
  let changed = 0;
  for (const item of items) {
    const next = scoreCandidates(
      item.cleanedName,
      item.companyCode ?? null,
      pool,
      rejectedByAlias.get(item.cleanedName.toLowerCase()),
    );
    if (sameCandidates(item.candidates, next)) continue;
    changed += 1;
    await db
      .update(reviewItems)
      .set({ candidates: next, candidatesComputedAt: now, updatedAt: now })
      .where(eq(reviewItems.id, item.id));
  }

  // Stamp everything that was re-scored, including the items whose list did not
  // move: "checked just now, still nothing" is exactly the state the queue
  // could not previously distinguish from "checked months ago".
  await db
    .update(reviewItems)
    .set({ candidatesComputedAt: now })
    .where(
      and(
        eq(reviewItems.status, 'pending'),
        reviewItemIds ? inArray(reviewItems.id, reviewItemIds) : undefined,
      ),
    );

  return { scanned: items.length, changed };
}

/** Compare two ranked lists for equality, ignoring float noise in the scores. */
function sameCandidates(stored: unknown, next: ReviewCandidateSnapshot[]): boolean {
  const previous = Array.isArray(stored) ? (stored as ReviewCandidateSnapshot[]) : [];
  if (previous.length !== next.length) return false;
  return previous.every((entry, index) => {
    const candidate = next[index]!;
    return (
      entry.playerId === candidate.playerId &&
      entry.reason === candidate.reason &&
      Math.abs((entry.score ?? 0) - candidate.score) < 1e-9 &&
      entry.name === candidate.name &&
      (entry.companyCode ?? null) === candidate.companyCode &&
      (entry.matchedAlias ?? null) === candidate.matchedAlias
    );
  });
}
