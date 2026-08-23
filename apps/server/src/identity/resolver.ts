import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { companies, companyAliases, identityDecisions, playerAliases } from '@smashclub/db';
import {
  cleanPlayerEntry,
  preparePlayerEntry,
  resolveStructuredAlias,
  type CompanyTaxonomy,
} from '@smashclub/engine';
import { loadCandidatePool, scoreCandidates, type ReviewCandidateSnapshot } from './candidates';

/**
 * The identity pipeline as a *read*: given some arbitrary text that names a
 * person, say who the club thinks it is and how confident that answer is —
 * without writing anything.
 *
 * This is the same ladder the sync-time matcher climbs, and deliberately the
 * only copy of it:
 *
 *  1. clean the raw entry (company tag, @, parentheticals, ...)
 *  2. exact alias lookup (company-scoped, then company-less)
 *  3. prior human decision in identity_decisions (merge)
 *  4. structured short-form alias, unambiguous within the pool right now
 *  5. otherwise unresolved, with ranked candidates for a human to choose from.
 *     Fuzzy similarity NEVER selects on its own, here or anywhere.
 *
 * `matchTournamentParticipants` calls this and then performs its
 * tournament-specific writes; the event planner calls it on pasted attendance
 * lines and writes nothing at all. Splitting the ladder out is what keeps the
 * planner from growing a second, subtly different matcher — the failure mode
 * would be a name that resolves one way on the night and another way when the
 * bracket syncs, producing two players for one person.
 */

export interface ResolutionPreview {
  /** The input exactly as given, so a correction can be shown against it. */
  rawInput: string;
  cleanedName: string;
  companyId: string | null;
  companyCode: string | null;
  /** Resolved player, or null when a human has to decide. */
  playerId: string | null;
  method: 'alias' | 'decision' | 'structured' | 'unresolved';
  /** Ranked suggestions. Never auto-selected — see the invariant above. */
  candidates: ReviewCandidateSnapshot[];
  /**
   * A company-shaped label the taxonomy does not recognise, e.g. a new employer
   * appearing for the first time. Surfaced rather than silently dropped.
   */
  unknownCompanyLabel: string | null;
}

export async function loadCompanyTaxonomy(db: Db): Promise<{
  taxonomy: CompanyTaxonomy;
  companyIdByCode: Map<string, string>;
}> {
  const companyRows = await db.select().from(companies);
  const aliasRows = await db.select().from(companyAliases);
  const codeById = new Map(companyRows.map((row) => [row.id, row.code]));
  const taxonomy: CompanyTaxonomy = { codes: {}, aliases: {} };
  const companyIdByCode = new Map<string, string>();
  for (const row of companyRows) {
    taxonomy.codes[row.code] = row.name;
    taxonomy.aliases[row.name] = row.code;
    companyIdByCode.set(row.code, row.id);
  }
  for (const alias of aliasRows) {
    const code = codeById.get(alias.companyId);
    if (code) taxonomy.aliases[alias.aliasNorm] = code;
  }
  return { taxonomy, companyIdByCode };
}

export interface ResolveOptions {
  /**
   * Rank candidates even for rows that resolved. Off for the sync pipeline,
   * which only needs them for the review queue; on for the planner, where an
   * admin is looking at a structured guess and may want the alternatives.
   */
  scoreResolvedCandidates?: boolean;
}

/** One input. Convenience wrapper — the batch form is what does the work. */
export async function resolvePlayerInput(
  db: Db,
  rawInput: string,
  options: ResolveOptions = {},
): Promise<ResolutionPreview> {
  const [only] = await resolvePlayerInputs(db, [rawInput], options);
  return only!;
}

/**
 * Resolve many inputs against one snapshot of the club's identity data.
 *
 * Batched on purpose: the per-row form issued three queries per name, which is
 * fine for a bracket synced in the background and not fine for a roster an
 * admin is retyping in front of a projector.
 */
export async function resolvePlayerInputs(
  db: Db,
  rawInputs: readonly string[],
  options: ResolveOptions = {},
): Promise<ResolutionPreview[]> {
  if (rawInputs.length === 0) return [];

  const { taxonomy, companyIdByCode } = await loadCompanyTaxonomy(db);
  const pool = await loadCandidatePool(db);

  const cleaned = rawInputs.map((rawInput) => {
    const prepared = preparePlayerEntry(rawInput, taxonomy);
    const entry = cleanPlayerEntry(prepared, taxonomy);
    const companyCode = entry.companyCode && taxonomy.codes[entry.companyCode] ? entry.companyCode : null;
    return {
      rawInput,
      cleanedName: entry.name,
      aliasNorm: entry.name.toLowerCase(),
      companyCode,
      companyId: companyCode ? (companyIdByCode.get(companyCode) ?? null) : null,
      unknownCompanyLabel: entry.unknownCompanyLabel ?? null,
    };
  });

  const norms = [...new Set(cleaned.map((row) => row.aliasNorm))];
  const aliasRows = norms.length
    ? await db.select().from(playerAliases).where(inArray(playerAliases.aliasNorm, norms))
    : [];
  const decisionRows = norms.length
    ? await db
        .select()
        .from(identityDecisions)
        .where(and(eq(identityDecisions.kind, 'merge'), inArray(identityDecisions.aliasNorm, norms)))
    : [];
  const rejectionRows = norms.length
    ? await db
        .select()
        .from(identityDecisions)
        .where(and(eq(identityDecisions.kind, 'keep_separate'), inArray(identityDecisions.aliasNorm, norms)))
    : [];

  const aliasesByNorm = groupBy(aliasRows, (row) => row.aliasNorm);
  const decisionsByNorm = groupBy(decisionRows, (row) => row.aliasNorm);
  const rejectedByNorm = new Map<string, Set<string>>();
  for (const row of rejectionRows) {
    if (!row.keptSeparateFromPlayerId) continue;
    const set = rejectedByNorm.get(row.aliasNorm) ?? new Set<string>();
    set.add(row.keptSeparateFromPlayerId);
    rejectedByNorm.set(row.aliasNorm, set);
  }

  return cleaned.map((row) => {
    const base = {
      rawInput: row.rawInput,
      cleanedName: row.cleanedName,
      companyId: row.companyId,
      companyCode: row.companyCode,
      unknownCompanyLabel: row.unknownCompanyLabel,
    };
    const candidatesFor = (playerId: string | null) =>
      playerId === null || options.scoreResolvedCandidates
        ? scoreCandidates(row.cleanedName, row.companyCode, pool, rejectedByNorm.get(row.aliasNorm))
        : [];

    // 2. Exact alias: company-scoped first, then company-less. A single alias
    // under *another* company still matches an entry with no company signal at
    // all — the legacy "N/A" behaviour.
    const aliases = aliasesByNorm.get(row.aliasNorm) ?? [];
    const aliasHit =
      (row.companyId ? aliases.find((alias) => alias.companyId === row.companyId) : undefined) ??
      aliases.find((alias) => alias.companyId === null) ??
      (row.companyId === null && aliases.length === 1 ? aliases[0] : undefined);
    if (aliasHit) {
      return { ...base, playerId: aliasHit.playerId, method: 'alias' as const, candidates: candidatesFor(aliasHit.playerId) };
    }

    // 3. Prior human decision.
    const decisions = decisionsByNorm.get(row.aliasNorm) ?? [];
    const decision =
      (row.companyId ? decisions.find((entry) => entry.companyId === row.companyId) : undefined) ??
      decisions.find((entry) => entry.companyId === null);
    if (decision?.playerId) {
      return { ...base, playerId: decision.playerId, method: 'decision' as const, candidates: candidatesFor(decision.playerId) };
    }

    // 4. Structured short form, unambiguous within the pool as it stands now.
    const structured = resolveStructuredAlias(row.cleanedName, row.companyCode, pool);
    if (structured) {
      return { ...base, playerId: structured.playerId, method: 'structured' as const, candidates: candidatesFor(structured.playerId) };
    }

    // 5. A human decides.
    return { ...base, playerId: null, method: 'unresolved' as const, candidates: candidatesFor(null) };
  });
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}
