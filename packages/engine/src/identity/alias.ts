import { similarityRatio } from './similarity';

/**
 * Identity-matching primitives, ported from the legacy pipeline. The core
 * invariant carried over from the CLI (and made absolute in the web app):
 * fuzzy similarity NEVER merges identities by itself — it only produces
 * ranked candidates for a human decision in the review queue.
 */

export interface IdentityCandidate {
  /** Cleaned canonical name, e.g. "Fox McCloud". */
  name: string;
  /** Company code (e.g. ATL) or null when unknown. */
  companyCode: string | null;
  /**
   * Other spellings this identity already answers to. Matching considers them
   * exactly like the canonical name: a player whose registry name is "Fox
   * McCloud" but who enters brackets as "starfox" should be offered for a
   * "starfoxx" typo, which name-only scoring could never see.
   */
  aliases?: readonly string[];
}

export interface ScoredCandidate<T extends IdentityCandidate = IdentityCandidate> {
  candidate: T;
  score: number;
  reason: 'fuzzy' | 'structured' | 'name-shape';
  /** Which of the candidate's spellings produced the score. */
  matchedName: string;
}

/**
 * Every spelling an identity answers to — canonical name first, then aliases —
 * deduped case-insensitively so an alias that merely restates the name does not
 * make the candidate look twice as matchable.
 */
export function candidateNames(candidate: IdentityCandidate): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of [candidate.name, ...(candidate.aliases ?? [])]) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** "matt" ~ "matthew": equal, or one is a >=4-char prefix of the other. */
export function firstNameCompatible(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la === lb || (la.length >= 4 && lb.startsWith(la)) || (lb.length >= 4 && la.startsWith(lb));
}

/**
 * Fuzzy similarity against a candidate pool (legacy find_similar_player).
 * Returns the single best candidate at or above the 0.6 floor, scored across
 * every spelling it answers to (name and aliases). Score is the max of the
 * whole-string difflib ratio and, for two multi-part names, the average of
 * first-part and last-part ratios.
 *
 * Company scoping: when the query has a company, only candidates from the
 * same company or with no company are considered. (The legacy version only
 * recognised ATL/GOOG in this filter, accidentally excluding same-company
 * candidates elsewhere; since fuzzy results only ever feed the review queue,
 * the fixed inclusive filter strictly surfaces better candidates.)
 */
export function findSimilarPlayer<T extends IdentityCandidate>(
  name: string,
  companyCode: string | null,
  candidates: readonly T[],
): { candidate: T; score: number; matchedName: string } | null {
  const normalizedName = name.toLowerCase().trim();
  if (!normalizedName) return null;

  let best: T | null = null;
  let bestName = '';
  let bestScore = 0;
  for (const candidate of candidates) {
    if (companyCode && candidate.companyCode && candidate.companyCode !== companyCode) continue;

    for (const candidateName of candidateNames(candidate)) {
      const ratio = nameSimilarity(normalizedName, candidateName.toLowerCase());
      if (ratio > bestScore) {
        bestScore = ratio;
        best = candidate;
        bestName = candidateName;
      }
    }
  }

  return best && bestScore >= 0.6 ? { candidate: best, score: bestScore, matchedName: bestName } : null;
}

/**
 * Similarity between two already-lowercased names: the whole-string difflib
 * ratio, or — when both are multi-part — the average of the first-part and
 * last-part ratios, whichever is kinder.
 */
function nameSimilarity(query: string, candidateName: string): number {
  let ratio = similarityRatio(query, candidateName);

  const inputParts = query.split(/\s+/).filter(Boolean);
  const candidateParts = candidateName.split(/\s+/).filter(Boolean);
  if (inputParts.length >= 2 && candidateParts.length >= 2) {
    const firstMatch = similarityRatio(inputParts[0]!, candidateParts[0]!);
    const lastMatch = similarityRatio(inputParts[inputParts.length - 1]!, candidateParts[candidateParts.length - 1]!);
    ratio = Math.max(ratio, (firstMatch + lastMatch) / 2);
  }
  return ratio;
}

/**
 * Structured alias resolution (legacy _resolve_structured_alias): safe,
 * deterministic short forms that auto-link WITHOUT review because they are
 * unambiguous within the pool:
 * - "Fox" -> "Fox McCloud" when exactly one candidate shares that first name.
 * - "Fox M" / "Foxy M" -> "Fox McCloud" when compatible first name + last
 *   initial match exactly one candidate.
 * Returns null on any ambiguity.
 */
export function resolveStructuredAlias<T extends IdentityCandidate>(
  name: string,
  companyCode: string | null,
  candidates: readonly T[],
): T | null {
  return matchStructuredAlias(name, companyCode, candidates)?.candidate ?? null;
}

/**
 * As `resolveStructuredAlias`, but also reports which of the candidate's
 * spellings matched — a short form may resolve through an alias rather than
 * the registry name, and the review queue says so.
 */
export function matchStructuredAlias<T extends IdentityCandidate>(
  name: string,
  companyCode: string | null,
  candidates: readonly T[],
): { candidate: T; matchedName: string } | null {
  const parts = name.split(/\s+/).filter(Boolean);
  const pool = candidates.filter((entry) => companyCode === null || entry.companyCode === companyCode);
  if (pool.length === 0) return null;

  if (parts.length === 1) {
    return uniqueOrNull(
      matchesOf(pool, (entryName) => {
        const entryParts = entryName.split(/\s+/);
        return entryParts.length >= 2 && parts[0]!.toLowerCase() === entryParts[0]!.toLowerCase();
      }),
    );
  }

  if (parts.length === 2 && parts[1]!.length === 1) {
    const first = parts[0]!;
    const initial = parts[1]!.toLowerCase();
    return uniqueOrNull(
      matchesOf(pool, (entryName) => {
        const entryParts = entryName.split(/\s+/);
        if (entryParts.length < 2) return false;
        return (
          firstNameCompatible(first, entryParts[0]!) &&
          entryParts[entryParts.length - 1]!.toLowerCase().startsWith(initial)
        );
      }),
    );
  }

  return null;
}

/** Candidates with at least one spelling satisfying `predicate`, first hit kept. */
function matchesOf<T extends IdentityCandidate>(
  pool: readonly T[],
  predicate: (entryName: string) => boolean,
): Array<{ candidate: T; matchedName: string }> {
  const matches: Array<{ candidate: T; matchedName: string }> = [];
  for (const candidate of pool) {
    const matchedName = candidateNames(candidate).find(predicate);
    if (matchedName !== undefined) matches.push({ candidate, matchedName });
  }
  return matches;
}

function uniqueOrNull<T extends IdentityCandidate>(
  matches: ReadonlyArray<{ candidate: T; matchedName: string }>,
): { candidate: T; matchedName: string } | null {
  const unique = new Map<string, { candidate: T; matchedName: string }>();
  for (const match of matches) {
    unique.set(`${match.candidate.name} ${match.candidate.companyCode ?? ''}`, match);
  }
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

/**
 * Name-shape scoring used to rank review-queue candidates (legacy
 * _glicko_query_candidates tiers): 0.98 full first+last match, 0.92 initial
 * match, 0.84 bare-first-name match, 0 otherwise. These never auto-merge.
 */
export function scoreNameShape(queryName: string, candidateName: string): number {
  const queryParts = queryName.toLowerCase().split(/\s+/).filter(Boolean);
  const candidateParts = candidateName.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryParts.length === 0 || candidateParts.length === 0) return 0;

  if (queryParts.length >= 2 && candidateParts.length === 1 && queryParts[0] === candidateParts[0]) {
    return 0.84;
  }
  if (queryParts.length >= 2 && candidateParts.length >= 2 && queryParts[0] === candidateParts[0]) {
    const queryLast = queryParts[queryParts.length - 1]!;
    const candidateLast = candidateParts[candidateParts.length - 1]!;
    if (queryLast === candidateLast) return 0.98;
    if (candidateLast.length === 1 && queryLast.startsWith(candidateLast)) return 0.92;
    if (queryLast.length === 1 && candidateLast.startsWith(queryLast)) return 0.92;
  }
  if (queryParts.length === 1 && candidateParts.length >= 2 && queryParts[0] === candidateParts[0]) {
    return 0.84;
  }
  return 0;
}

/**
 * Rank candidates for a review-queue item: structured/name-shape tiers and
 * fuzzy ratios combined, best first. Pure — the caller decides what to do
 * (which, per the app's invariant, is always "ask a human").
 */
export function rankReviewCandidates<T extends IdentityCandidate>(
  name: string,
  companyCode: string | null,
  candidates: readonly T[],
  limit = 5,
): ScoredCandidate<T>[] {
  const scored = new Map<T, ScoredCandidate<T>>();

  const structured = matchStructuredAlias(name, companyCode, candidates);
  if (structured) {
    scored.set(structured.candidate, {
      candidate: structured.candidate,
      score: 0.99,
      reason: 'structured',
      matchedName: structured.matchedName,
    });
  }

  for (const candidate of candidates) {
    if (companyCode && candidate.companyCode && candidate.companyCode !== companyCode) continue;
    // Best-scoring spelling wins: an alias only ever helps a candidate up the
    // list, it never drags one down below what its registry name scored.
    let shape = 0;
    let shapeName = candidate.name;
    for (const candidateName of candidateNames(candidate)) {
      const score = scoreNameShape(name, candidateName);
      if (score > shape) {
        shape = score;
        shapeName = candidateName;
      }
    }
    const existing = scored.get(candidate);
    if (shape > 0 && (!existing || shape > existing.score)) {
      scored.set(candidate, { candidate, score: shape, reason: 'name-shape', matchedName: shapeName });
    }
  }

  const fuzzy = findSimilarPlayer(name, companyCode, candidates);
  if (fuzzy) {
    const existing = scored.get(fuzzy.candidate);
    if (!existing || fuzzy.score > existing.score) {
      scored.set(fuzzy.candidate, {
        candidate: fuzzy.candidate,
        score: fuzzy.score,
        reason: 'fuzzy',
        matchedName: fuzzy.matchedName,
      });
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit);
}

/**
 * Display-name specificity (legacy _display_specificity): prefer names with
 * a company tag, then more tokens, then more characters.
 */
export function displaySpecificity(displayName: string): [number, number, number] {
  const hasCompany = displayName.startsWith('[') ? 1 : 0;
  const cleaned = displayName.replace(/^\[[^\]]+\]\s*/, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return [hasCompany, parts.length, cleaned.length];
}

export function preferMoreSpecificDisplay(a: string, b: string): string {
  const sa = displaySpecificity(a);
  const sb = displaySpecificity(b);
  for (let i = 0; i < 3; i++) {
    if (sa[i]! !== sb[i]!) return sa[i]! > sb[i]! ? a : b;
  }
  return a;
}
