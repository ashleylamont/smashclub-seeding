/**
 * Client-side player lookup, shared by the admin surfaces that need to name a
 * player rather than pick one from a pre-scored list. Deliberately searches the
 * same three things identity matching does — registry name, public alias and
 * every stored alias — so a reviewer who knows a player only by their bracket
 * tag can still find them.
 */

export interface SearchablePlayer {
  id: string;
  canonicalName: string;
  displayName: string | null;
  companyCode: string | null;
  aliases: string[];
  status: string;
}

export interface PlayerMatch<T extends SearchablePlayer> {
  player: T;
  /** The alias that matched, when the hit was not on a name shown in the row. */
  matchedAlias: string | null;
  score: number;
}

/** Exact beats prefix beats substring; 0 means "not a match at all". */
function matchScore(value: string | null, query: string): number {
  const candidate = (value ?? '').trim().toLowerCase();
  if (candidate === '') return 0;
  if (candidate === query) return 3;
  if (candidate.startsWith(query)) return 2;
  if (candidate.includes(query)) return 1;
  return 0;
}

/**
 * Rank `players` against a free-text query, best first. Merged and retired
 * players are never returned: they cannot be linked to, so offering them would
 * only ever be a mis-click. An empty query lists everyone alphabetically, which
 * is what makes the lookup browsable rather than a guessing game.
 */
export function searchPlayers<T extends SearchablePlayer>(
  players: readonly T[],
  query: string,
  limit = 25,
): Array<PlayerMatch<T>> {
  const active = players.filter((player) => player.status === 'active');
  const normalized = query.trim().toLowerCase();

  const byName = (a: { player: T }, b: { player: T }) =>
    a.player.canonicalName.localeCompare(b.player.canonicalName);

  if (normalized === '') {
    return active
      .map((player) => ({ player, matchedAlias: null, score: 0 }))
      .sort(byName)
      .slice(0, limit);
  }

  const matches: Array<PlayerMatch<T>> = [];
  for (const player of active) {
    // Names first, so a hit on a name never gets attributed to an alias that
    // happens to score the same.
    let score = Math.max(matchScore(player.canonicalName, normalized), matchScore(player.displayName, normalized));
    let matchedAlias: string | null = null;
    for (const alias of player.aliases) {
      const aliasScore = matchScore(alias, normalized);
      if (aliasScore > score) {
        score = aliasScore;
        matchedAlias = alias;
      }
    }
    if (score > 0) matches.push({ player, matchedAlias, score });
  }

  return matches.sort((a, b) => b.score - a.score || byName(a, b)).slice(0, limit);
}
