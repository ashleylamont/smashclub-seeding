import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import {
  companies,
  companyAliases,
  identityDecisions,
  playerAliases,
  players,
  reviewItems,
  sets,
  tournamentParticipants,
} from '@smashclub/db';
import {
  cleanPlayerEntry,
  preparePlayerEntry,
  rankReviewCandidates,
  resolveStructuredAlias,
  type CompanyTaxonomy,
} from '@smashclub/engine';

/**
 * The participant-identity pipeline, replacing the legacy CLI's blocking
 * prompts. Per participant, in order:
 *
 *  1. clean the raw display name (company tag, @, parentheticals, ...)
 *  2. exact alias lookup (company-scoped, then company-less)
 *  3. prior human decision in identity_decisions (merge -> silent link)
 *  4. structured short-form alias (unique first-name / first+initial) ->
 *     auto-link and record a `structured` alias
 *  5. everything else — including every fuzzy match at any score — becomes a
 *     pending review item with ranked candidates. Fuzzy similarity NEVER
 *     merges on its own.
 */

export interface MatchOutcome {
  participantId: string;
  cleanedName: string;
  companyId: string | null;
  playerId: string | null;
  method: 'existing' | 'alias' | 'decision' | 'structured' | 'queued';
}

export async function loadCompanyTaxonomy(db: Db): Promise<{
  taxonomy: CompanyTaxonomy;
  companyIdByCode: Map<string, string>;
}> {
  const companyRows = await db.select().from(companies);
  const aliasRows = await db.select().from(companyAliases);
  const nameById = new Map(companyRows.map((row) => [row.id, row.name]));
  const taxonomy: CompanyTaxonomy = { codes: {}, aliases: {} };
  const companyIdByCode = new Map<string, string>();
  for (const row of companyRows) {
    taxonomy.codes[row.code] = row.name;
    taxonomy.aliases[row.name] = row.code;
    companyIdByCode.set(row.code, row.id);
  }
  for (const alias of aliasRows) {
    const name = nameById.get(alias.companyId);
    if (name) {
      const code = companyRows.find((c) => c.id === alias.companyId)?.code;
      if (code) taxonomy.aliases[alias.aliasNorm] = code;
    }
  }
  return { taxonomy, companyIdByCode };
}

interface CandidatePlayer {
  name: string;
  companyCode: string | null;
  playerId: string;
}

async function loadCandidatePool(db: Db): Promise<CandidatePlayer[]> {
  const rows = await db
    .select({
      id: players.id,
      canonicalName: players.canonicalName,
      companyCode: companies.code,
    })
    .from(players)
    .leftJoin(companies, eq(players.companyId, companies.id))
    .where(eq(players.status, 'active'));
  return rows.map((row) => ({ name: row.canonicalName, companyCode: row.companyCode ?? null, playerId: row.id }));
}

/**
 * Resolve identities for a tournament's unresolved participants. Writes
 * participant.playerId on auto-links and creates pending review items for the
 * rest. Returns the outcomes for observability/tests.
 */
export async function matchTournamentParticipants(db: Db, tournamentId: string): Promise<MatchOutcome[]> {
  const { taxonomy, companyIdByCode } = await loadCompanyTaxonomy(db);
  const unresolved = await db
    .select()
    .from(tournamentParticipants)
    .where(and(eq(tournamentParticipants.tournamentId, tournamentId), isNull(tournamentParticipants.playerId)));
  if (unresolved.length === 0) return [];

  const pool = await loadCandidatePool(db);
  const outcomes: MatchOutcome[] = [];

  for (const participant of unresolved) {
    const prepared = preparePlayerEntry(participant.rawName, taxonomy);
    const cleaned = cleanPlayerEntry(prepared, taxonomy);
    const aliasNorm = cleaned.name.toLowerCase();
    const companyCode = cleaned.companyCode && taxonomy.codes[cleaned.companyCode] ? cleaned.companyCode : null;
    const companyId = companyCode ? (companyIdByCode.get(companyCode) ?? null) : null;

    await db
      .update(tournamentParticipants)
      .set({ cleanedName: cleaned.name, companyId, updatedAt: new Date() })
      .where(eq(tournamentParticipants.id, participant.id));

    // 2. Exact alias lookup: company-scoped first, then company-less.
    const aliasRows = await db
      .select()
      .from(playerAliases)
      .where(eq(playerAliases.aliasNorm, aliasNorm));
    const aliasHit =
      (companyId ? aliasRows.find((row) => row.companyId === companyId) : undefined) ??
      aliasRows.find((row) => row.companyId === null) ??
      // A single alias under another company still matches when the
      // participant has no company signal at all (legacy N/A behaviour).
      (companyId === null && aliasRows.length === 1 ? aliasRows[0] : undefined);
    if (aliasHit) {
      await linkParticipant(db, participant.id, aliasHit.playerId);
      outcomes.push({
        participantId: participant.id,
        cleanedName: cleaned.name,
        companyId,
        playerId: aliasHit.playerId,
        method: 'alias',
      });
      continue;
    }

    // 3. Prior human decision.
    const decisionRows = await db
      .select()
      .from(identityDecisions)
      .where(and(eq(identityDecisions.aliasNorm, aliasNorm), eq(identityDecisions.kind, 'merge')));
    const decision =
      (companyId ? decisionRows.find((row) => row.companyId === companyId) : undefined) ??
      decisionRows.find((row) => row.companyId === null);
    if (decision?.playerId) {
      await linkParticipant(db, participant.id, decision.playerId);
      await ensureAlias(db, decision.playerId, aliasNorm, companyId, 'merge_decision');
      outcomes.push({
        participantId: participant.id,
        cleanedName: cleaned.name,
        companyId,
        playerId: decision.playerId,
        method: 'decision',
      });
      continue;
    }

    // 4. Structured short-form alias (unambiguous within the pool).
    const structured = resolveStructuredAlias(cleaned.name, companyCode, pool);
    if (structured) {
      await linkParticipant(db, participant.id, structured.playerId);
      await ensureAlias(db, structured.playerId, aliasNorm, companyId, 'structured');
      outcomes.push({
        participantId: participant.id,
        cleanedName: cleaned.name,
        companyId,
        playerId: structured.playerId,
        method: 'structured',
      });
      continue;
    }

    // 5. Review queue. Rejected pairs (keep_separate) are filtered out of the
    // candidate list so a settled question is never re-asked.
    const rejected = await db
      .select()
      .from(identityDecisions)
      .where(and(eq(identityDecisions.aliasNorm, aliasNorm), eq(identityDecisions.kind, 'keep_separate')));
    const rejectedPlayerIds = new Set(rejected.map((row) => row.keptSeparateFromPlayerId).filter(Boolean));
    const candidates = rankReviewCandidates(cleaned.name, companyCode, pool).filter(
      (entry) => !rejectedPlayerIds.has(entry.candidate.playerId),
    );

    const existingPending = await db
      .select({ id: reviewItems.id })
      .from(reviewItems)
      .where(and(eq(reviewItems.tournamentParticipantId, participant.id), eq(reviewItems.status, 'pending')));
    if (existingPending.length === 0) {
      await db.insert(reviewItems).values({
        tournamentParticipantId: participant.id,
        rawName: participant.rawName,
        cleanedName: cleaned.name,
        companyId,
        candidates: candidates.map((entry) => ({
          playerId: entry.candidate.playerId,
          name: entry.candidate.name,
          companyCode: entry.candidate.companyCode,
          score: entry.score,
          reason: entry.reason,
        })),
      });
    }
    outcomes.push({
      participantId: participant.id,
      cleanedName: cleaned.name,
      companyId,
      playerId: null,
      method: 'queued',
    });
  }

  await backfillSetPlayers(db, tournamentId);
  return outcomes;
}

async function linkParticipant(db: Db, participantId: string, playerId: string): Promise<void> {
  await db
    .update(tournamentParticipants)
    .set({ playerId, updatedAt: new Date() })
    .where(eq(tournamentParticipants.id, participantId));
}

export async function ensureAlias(
  db: Db,
  playerId: string,
  aliasNorm: string,
  companyId: string | null,
  source: 'registry' | 'challonge' | 'structured' | 'manual' | 'merge_decision',
): Promise<void> {
  await db
    .insert(playerAliases)
    .values({ playerId, aliasNorm, companyId, source })
    .onConflictDoNothing();
}

/** Denormalise participants' resolved player IDs onto their sets. */
export async function backfillSetPlayers(db: Db, tournamentId: string): Promise<void> {
  const participants = await db
    .select({ id: tournamentParticipants.id, playerId: tournamentParticipants.playerId })
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, tournamentId));
  const byId = new Map(participants.map((row) => [row.id, row.playerId]));

  const setRows = await db
    .select({
      id: sets.id,
      p1ParticipantId: sets.p1ParticipantId,
      p2ParticipantId: sets.p2ParticipantId,
      p1PlayerId: sets.p1PlayerId,
      p2PlayerId: sets.p2PlayerId,
    })
    .from(sets)
    .where(eq(sets.tournamentId, tournamentId));

  for (const row of setRows) {
    const p1 = row.p1ParticipantId ? (byId.get(row.p1ParticipantId) ?? null) : null;
    const p2 = row.p2ParticipantId ? (byId.get(row.p2ParticipantId) ?? null) : null;
    if (p1 !== row.p1PlayerId || p2 !== row.p2PlayerId) {
      await db.update(sets).set({ p1PlayerId: p1, p2PlayerId: p2, updatedAt: new Date() }).where(eq(sets.id, row.id));
    }
  }
}

/** Re-run backfill for every tournament a player appears in (post-merge). */
export async function backfillPlayerEverywhere(db: Db, playerIds: string[]): Promise<void> {
  if (playerIds.length === 0) return;
  const rows = await db
    .selectDistinct({ tournamentId: tournamentParticipants.tournamentId })
    .from(tournamentParticipants)
    .where(inArray(tournamentParticipants.playerId, playerIds));
  for (const row of rows) {
    await backfillSetPlayers(db, row.tournamentId);
  }
}
