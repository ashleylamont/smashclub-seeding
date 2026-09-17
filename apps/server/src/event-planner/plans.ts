import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import {
  companies,
  eventPlanBrackets,
  eventMatches,
  eventPoolAssignments,
  eventWithdrawals,
  eventPlanEntries,
  eventPlanPoolPlacements,
  eventPlans,
  playerRatings,
  players,
  tournaments,
} from '@smashclub/db';
import { normalizeTournamentId } from '@smashclub/engine';
import { publicPlayerName } from '@smashclub/shared';
import { latestRecomputeId } from '../recompute/recompute';
import { resolvePlayerInputs } from '../identity/resolver';
import type { ReviewCandidateSnapshot } from '../identity/candidates';
import {
  assignDivisions,
  validateDivisionInput,
  type Division,
  type DivisionCandidate,
  type DivisionPreference,
  type PlanIssue,
  EventPlanValidationError,
} from './divisions';
import { poolLabel, stripeIntoPools } from './pools';
import { buildConsolationBracket, championshipQualifiers, type ConsolationBracket } from './advancement';
import { parseRosterText, resolveRoster, type RosterResolution } from './roster';

/**
 * Event-plan persistence: the durable half of the planner.
 *
 * Two rules run through all of it. Plan state is enforced *here*, not in the
 * browser — a disabled button is a hint, and an event that is already underway
 * must not be reseeded by a stale tab. And a freeze is a snapshot: once taken,
 * a later recompute moving somebody's rank must not silently move them between
 * divisions on the night.
 */

export type PlanStatus = 'draft' | 'roster_frozen' | 'pools_ready' | 'underway' | 'complete' | 'cancelled';
export type BracketStage = 'main' | 'consolation';

/** The four brackets a two-division club night needs, in handoff order. */
export const BRACKET_SLOTS: ReadonlyArray<{ division: Division; stage: BracketStage }> = [
  { division: 'upper', stage: 'main' },
  { division: 'upper', stage: 'consolation' },
  { division: 'lower', stage: 'main' },
  { division: 'lower', stage: 'consolation' },
];

export class EventPlanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventPlanStateError';
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Current leaderboard standing per player, from the latest complete recompute. */
export async function loadRanking(
  db: Db,
): Promise<{ recomputeId: string | null; ranking: Map<string, { rank: number; conservativeRating: number }> }> {
  const recomputeId = await latestRecomputeId(db);
  const ranking = new Map<string, { rank: number; conservativeRating: number }>();
  if (!recomputeId) return { recomputeId, ranking };
  const rows = await db
    .select({
      playerId: playerRatings.playerId,
      rank: playerRatings.rank,
      conservativeRating: playerRatings.conservativeRating,
    })
    .from(playerRatings)
    .where(eq(playerRatings.recomputeId, recomputeId));
  for (const row of rows) {
    ranking.set(row.playerId, { rank: row.rank, conservativeRating: row.conservativeRating });
  }
  return { recomputeId, ranking };
}

/** Parse and resolve a pasted roster without writing anything. */
export async function previewRoster(db: Db, text: string): Promise<RosterResolution[]> {
  const { ranking } = await loadRanking(db);
  return resolveRoster(db, parseRosterText(text), ranking);
}

export interface PlanEntryView {
  id: string;
  sourceLineNumber: number;
  rawInput: string;
  cleanedName: string;
  companyCode: string | null;
  playerId: string | null;
  /** Registry name — an admin surface, so shown in full. */
  playerName: string | null;
  withdrawn?: boolean;
  /** What the export and every public surface will call them. */
  publicName: string | null;
  playerStatus: string | null;
  resolutionMethod: string;
  divisionPreference: DivisionPreference;
  assignedDivision: Division | null;
  snapshotRank: number | null;
  snapshotScore: number | null;
  divisionSeed: number | null;
  /** Where they stand on the board *now*, which a frozen plan may disagree with. */
  currentRank: number | null;
  currentScore: number | null;
  lastPlayedDate: string | null;
  /** Ranked suggestions for an unresolved row. Never auto-selected. */
  candidates: ReviewCandidateSnapshot[];
}

export interface PoolView {
  poolIndex: number;
  label: string;
  matchRevisions?: Array<{id:string;revision:number}>;
  placementRevision?: string;
  members: Array<{
    entryId: string;
    playerId: string;
    name: string;
    seed: number;
    snapshotRank: number | null;
    /** Confirmed finish, once the worksheet has been filled in. */
    place: number | null;
    withdrawn?: boolean;
  }>;
}

export interface DivisionView {
  division: Division;
  size: number;
  poolCount: number;
  pools: PoolView[];
  /** Null until every pool in the division has a confirmed 1-4. */
  consolation: ConsolationBracket | null;
  championship: Array<{ playerId: string; name: string; label: string }>;
}

export interface PlanView {
  plan: {
    id: string;
    name: string;
    eventDate: string;
    slugPrefix: string | null;
    status: PlanStatus;
    upperTargetSize: number | null;
    poolSize: number;
    rankingSnapshotAt: string | null;
    createdAt: string;
  };
  entries: PlanEntryView[];
  divisions: DivisionView[];
  brackets: Array<{
    id: string;
    division: Division;
    stage: BracketStage;
    challongeSlug: string | null;
    tournamentId: string | null;
    externalState: string;
    lastError: string | null;
    /** The tournament row's event date, so a mismatch is visible not implied. */
    tournamentEventDate: string | null;
    tournamentSyncState: string | null;
    tournamentIsRookie: boolean | null;
    suggestedSlug: string;
  }>;
  issues: { blocking: PlanIssue[]; warnings: PlanIssue[] };
}

export async function getPlan(db: Db, planId: string): Promise<PlanView | null> {
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId));
  if (!plan) return null;

  const rows = await db
    .select({
      entry: eventPlanEntries,
      companyCode: companies.code,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
      playerStatus: players.status,
    })
    .from(eventPlanEntries)
    .leftJoin(companies, eq(eventPlanEntries.companyId, companies.id))
    .leftJoin(players, eq(eventPlanEntries.playerId, players.id))
    .where(eq(eventPlanEntries.eventPlanId, planId))
    .orderBy(asc(eventPlanEntries.sourceLineNumber));

  const { ranking } = await loadRanking(db);
  const lastPlayed = await loadLastPlayed(
    db,
    rows.map((row) => row.entry.playerId).filter((id): id is string => id !== null),
  );

  // Unresolved rows get a fresh candidate list: players created since the paste
  // — very much including the one the admin just minted — would otherwise be
  // invisible to the row that needed them.
  const unresolved = rows.filter((row) => row.entry.playerId === null);
  const rescored = await resolvePlayerInputs(
    db,
    unresolved.map((row) => row.entry.rawInput),
  );
  const candidatesByEntry = new Map<string, ReviewCandidateSnapshot[]>();
  unresolved.forEach((row, index) => {
    candidatesByEntry.set(row.entry.id, rescored[index]?.candidates ?? []);
  });

  const entries: PlanEntryView[] = rows.map((row) => {
    const rating = row.entry.playerId ? ranking.get(row.entry.playerId) : undefined;
    return {
      id: row.entry.id,
      sourceLineNumber: row.entry.sourceLineNumber,
      rawInput: row.entry.rawInput,
      cleanedName: row.entry.cleanedName,
      companyCode: row.companyCode ?? null,
      playerId: row.entry.playerId,
      playerName: row.canonicalName ?? null,
      publicName: row.canonicalName
        ? publicPlayerName({ displayName: row.displayName, canonicalName: row.canonicalName })
        : null,
      playerStatus: row.playerStatus ?? null,
      resolutionMethod: row.entry.resolutionMethod,
      divisionPreference: row.entry.divisionPreference,
      assignedDivision: row.entry.assignedDivision,
      snapshotRank: row.entry.snapshotRank,
      snapshotScore: row.entry.snapshotScore,
      divisionSeed: row.entry.divisionSeed,
      currentRank: rating?.rank ?? null,
      currentScore: rating?.conservativeRating ?? null,
      lastPlayedDate: row.entry.playerId ? (lastPlayed.get(row.entry.playerId) ?? null) : null,
      candidates: candidatesByEntry.get(row.entry.id) ?? [],
    };
  });

  const placements = await db
    .select()
    .from(eventPlanPoolPlacements)
    .where(eq(eventPlanPoolPlacements.eventPlanId, planId));
  const assignments = await db.select().from(eventPoolAssignments).where(eq(eventPoolAssignments.eventPlanId, planId));
  const withdrawals = await db.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, planId));
  const withdrawn = new Set(withdrawals.map(row => row.playerId));
  for (const entry of entries) entry.withdrawn = !!entry.playerId && withdrawn.has(entry.playerId);
  const divisions = buildDivisionViews(entries, plan.poolSize, placements, assignments);
  const operationalMatches=await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId,planId));
  for(const division of divisions)for(const pool of division.pools){
    pool.matchRevisions=operationalMatches.filter(m=>m.division===division.division&&m.stage==='group'&&m.poolIndex===pool.poolIndex).map(m=>({id:m.id,revision:m.revision}));
    pool.placementRevision=createHash('sha256').update(JSON.stringify(placements.filter(p=>p.division===division.division&&p.poolIndex===pool.poolIndex).sort((a,b)=>a.playerId.localeCompare(b.playerId)).map(p=>[p.id,p.playerId,p.place,p.updatedAt]))).digest('hex');
  }


  const bracketRows = await db
    .select({
      bracket: eventPlanBrackets,
      tournamentEventDate: tournaments.eventDate,
      tournamentSyncState: tournaments.syncState,
      tournamentIsRookie: tournaments.isRookie,
    })
    .from(eventPlanBrackets)
    .leftJoin(tournaments, eq(eventPlanBrackets.tournamentId, tournaments.id))
    .where(eq(eventPlanBrackets.eventPlanId, planId));
  const bracketBySlot = new Map(
    bracketRows.map((row) => [`${row.bracket.division}:${row.bracket.stage}`, row]),
  );

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      eventDate: plan.eventDate.toISOString(),
      slugPrefix: plan.slugPrefix,
      status: plan.status,
      upperTargetSize: plan.upperTargetSize,
      poolSize: plan.poolSize,
      rankingSnapshotAt: plan.rankingSnapshotAt?.toISOString() ?? null,
      createdAt: plan.createdAt.toISOString(),
    },
    entries,
    divisions,
    brackets: BRACKET_SLOTS.map((slot) => {
      const row = bracketBySlot.get(`${slot.division}:${slot.stage}`);
      return {
        id: row?.bracket.id ?? '',
        division: slot.division,
        stage: slot.stage,
        challongeSlug: row?.bracket.challongeSlug ?? null,
        tournamentId: row?.bracket.tournamentId ?? null,
        externalState: row?.bracket.externalState ?? 'draft',
        lastError: row?.bracket.lastError ?? null,
        tournamentEventDate: row?.tournamentEventDate?.toISOString() ?? null,
        tournamentSyncState: row?.tournamentSyncState ?? null,
        tournamentIsRookie: row?.tournamentIsRookie ?? null,
        suggestedSlug: suggestedSlug(plan.slugPrefix ?? plan.name, slot.division, slot.stage),
      };
    }),
    issues: (()=>{const issues=planIssues(entries, plan.upperTargetSize, plan.poolSize);if(withdrawals.length)issues.warnings.push({code:'withdrawal_advancement',message:'Withdrawn entrants stay in the recorded finishing order but are excluded from advancement. Reconfirm affected pools: the first two active entrants advance to championship, and remaining active entrants enter consolation. Reconcile linked Challonge brackets manually.'});return issues;})(),
  };
}

/** `<prefix>-upper-consolation`, and friends. Advisory: Challonge owns the name. */
export function suggestedSlug(prefix: string, division: Division, stage: BracketStage): string {
  const base = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return [base || 'event', division, stage === 'consolation' ? 'consolation' : null].filter(Boolean).join('_');
}

function buildDivisionViews(
  entries: readonly PlanEntryView[],
  poolSize: number,
  placements: ReadonlyArray<{ division: Division; poolIndex: number; playerId: string; place: number }>,
  assignments: ReadonlyArray<{ division: Division; poolIndex: number; playerId: string }> = [],
): DivisionView[] {
  const views: DivisionView[] = [];
  for (const division of ['upper', 'lower'] as const) {
    const members = entries
      .filter((entry) => entry.assignedDivision === division && entry.divisionSeed !== null)
      .sort((a, b) => a.divisionSeed! - b.divisionSeed!);
    if (members.length < Math.max(3, poolSize - 1)) {
      views.push({
        division,
        size: members.length,
        poolCount: 0,
        pools: [],
        consolation: null,
        championship: [],
      });
      continue;
    }

    const divisionPlacements = placements.filter((placement) => placement.division === division);
    const placeByPlayer = new Map(divisionPlacements.map((placement) => [placement.playerId, placement.place]));
    const saved = assignments.filter(a => a.division === division);
    const poolMembers = saved.length ? Array.from({length: Math.max(...saved.map(a=>a.poolIndex))+1}, (_, index) => members.filter(m=>saved.some(a=>a.poolIndex===index&&a.playerId===m.playerId))) : stripeIntoPools(members, poolSize);
    const pools: PoolView[] = poolMembers.map((poolMembers, poolIndex) => ({
      poolIndex,
      label: poolLabel(poolIndex),
      members: poolMembers.map((entry) => ({
        entryId: entry.id,
        playerId: entry.playerId!,
        name: entry.publicName ?? entry.cleanedName,
        seed: entry.divisionSeed!,
        snapshotRank: entry.snapshotRank,
        place: placeByPlayer.get(entry.playerId!) ?? null,
        withdrawn: entry.withdrawn,
      })),
    }));

    const complete =
      pools.length > 0 && pools.every((pool) => pool.members.every((member) => member.place !== null));
    const finishers = complete
      ? pools.flatMap((pool) =>
          [...pool.members].filter(member=>!member.withdrawn).sort((a,b)=>a.place!-b.place!).map((member,index) => ({
            playerId: member.playerId,
            poolIndex: pool.poolIndex,
            place: index+1,
          })),
        )
      : [];
    const nameByPlayer = new Map(
      members.map((entry) => [entry.playerId!, entry.publicName ?? entry.cleanedName]),
    );

    views.push({
      division,
      size: members.length,
      poolCount: pools.length,
      pools,
      consolation: complete && finishers.some(f=>f.place>=3) ? buildConsolationBracket(finishers) : null,
      championship: complete
        ? championshipQualifiers(finishers).map((qualifier) => ({
            playerId: qualifier.playerId,
            name: nameByPlayer.get(qualifier.playerId) ?? '?',
            label: qualifier.label,
          }))
        : [],
    });
  }
  return views;
}

/** Everything blocking a freeze, plus the things worth a second look. */
export function planIssues(
  entries: readonly PlanEntryView[],
  upperTargetSize: number | null,
  poolSize: number,
): { blocking: PlanIssue[]; warnings: PlanIssue[] } {
  const blocking: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];

  const unresolved = entries.filter((entry) => entry.playerId === null);
  if (unresolved.length > 0) {
    blocking.push({
      code: 'unresolved_rows',
      message: `${unresolved.length} row(s) are not matched to a player yet.`,
      entryIds: unresolved.map((entry) => entry.id),
    });
  }

  const candidates: DivisionCandidate[] = entries
    .filter((entry) => entry.playerId !== null)
    .map((entry) => ({
      entryId: entry.id,
      playerId: entry.playerId!,
      divisionPreference: entry.divisionPreference,
      snapshotRank: entry.snapshotRank ?? entry.currentRank,
      sourceLineNumber: entry.sourceLineNumber,
    }));
  blocking.push(...validateDivisionInput(candidates, { upperTargetSize, poolSize }));

  // Two lines that cleaned to the same name but landed on different people is
  // usually a mis-correction, and is exactly the mistake that produces a bracket
  // with somebody's twin in it.
  const byCleanedName = new Map<string, PlanEntryView[]>();
  for (const entry of entries) {
    const key = entry.cleanedName.toLowerCase();
    byCleanedName.set(key, [...(byCleanedName.get(key) ?? []), entry]);
  }
  for (const [name, group] of byCleanedName) {
    const distinct = new Set(group.map((entry) => entry.playerId));
    if (group.length > 1 && distinct.size > 1) {
      warnings.push({
        code: 'same_name_different_players',
        message: `“${name}” appears on ${group.length} rows resolved to different players.`,
        entryIds: group.map((entry) => entry.id),
      });
    }
  }

  const structured = entries.filter((entry) => entry.resolutionMethod === 'structured');
  if (structured.length > 0) {
    warnings.push({
      code: 'structured_unconfirmed',
      message:
        `${structured.length} row(s) matched on a short form (“Josh C”) rather than an exact name. ` +
        'Worth a glance before freezing.',
      entryIds: structured.map((entry) => entry.id),
    });
  }

  const inactive = entries.filter((entry) => entry.playerStatus === 'merged');
  if (inactive.length > 0) {
    warnings.push({
      code: 'merged_player',
      message: `${inactive.length} row(s) point at a player that has been merged into another.`,
      entryIds: inactive.map((entry) => entry.id),
    });
  }

  const unrated = entries.filter((entry) => entry.playerId !== null && entry.currentRank === null);
  if (unrated.length > 0) {
    warnings.push({
      code: 'unrated_player',
      message: `${unrated.length} entrant(s) have no rating yet and will seed at the bottom of their division.`,
      entryIds: unrated.map((entry) => entry.id),
    });
  }

  return { blocking, warnings };
}

async function loadLastPlayed(db: Db, playerIds: readonly string[]): Promise<Map<string, string>> {
  if (playerIds.length === 0) return new Map();
  const recomputeId = await latestRecomputeId(db);
  if (!recomputeId) return new Map();
  const rows = await db
    .select({ playerId: playerRatings.playerId, lastPlayedDate: playerRatings.lastPlayedDate })
    .from(playerRatings)
    .where(and(eq(playerRatings.recomputeId, recomputeId), inArray(playerRatings.playerId, [...playerIds])));
  return new Map(rows.map((row) => [row.playerId, row.lastPlayedDate]));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface CreatePlanInput {
  name: string;
  eventDate: Date;
  slugPrefix?: string | null;
  upperTargetSize?: number | null;
  rows: Array<{
    lineNumber: number;
    rawInput: string;
    cleanedName: string;
    companyId: string | null;
    playerId: string | null;
    resolutionMethod: 'alias' | 'decision' | 'structured' | 'manual' | 'new' | 'unresolved';
    divisionPreference: DivisionPreference;
  }>;
}

export async function createPlan(db: Db, input: CreatePlanInput, createdBy: string | null): Promise<string> {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(eventPlans)
      .values({
        name: input.name,
        eventDate: input.eventDate,
        slugPrefix: input.slugPrefix ?? null,
        upperTargetSize: input.upperTargetSize ?? null,
        createdBy,
      })
      .returning({ id: eventPlans.id });
    const planId = plan!.id;
    if (input.rows.length > 0) {
      await tx.insert(eventPlanEntries).values(
        input.rows.map((row) => ({
          eventPlanId: planId,
          sourceLineNumber: row.lineNumber,
          rawInput: row.rawInput,
          cleanedName: row.cleanedName,
          companyId: row.companyId,
          playerId: row.playerId,
          resolutionMethod: row.resolutionMethod,
          divisionPreference: row.divisionPreference,
        })),
      );
    }
    // The four brackets exist as slots from the start, so the handoff screen has
    // somewhere to put a slug the moment one is created.
    await tx
      .insert(eventPlanBrackets)
      .values(BRACKET_SLOTS.map((slot) => ({ eventPlanId: planId, ...slot })));
    return planId;
  });
}

async function loadPlanRow(db: Db, planId: string) {
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId));
  if (!plan) throw new EventPlanStateError('That event plan no longer exists.');
  return plan;
}

/**
 * Refuse a change that would leave the plan disagreeing with a bracket people
 * are already playing. Once a slug exists, the seeds belong to Challonge.
 */
async function assertNoAttachedBracket(db: Db, planId: string, message: string): Promise<void> {
  const attached = await db
    .select({ slug: eventPlanBrackets.challongeSlug })
    .from(eventPlanBrackets)
    .where(eq(eventPlanBrackets.eventPlanId, planId));
  if (attached.some((row) => row.slug !== null)) throw new EventPlanStateError(message);
}

/** Guard a mutation against the plan's state. */
function assertStatus(status: PlanStatus, allowed: readonly PlanStatus[], action: string): void {
  if (!allowed.includes(status)) {
    throw new EventPlanStateError(
      `Cannot ${action} while the plan is “${status}”. Allowed from: ${allowed.join(', ')}.`,
    );
  }
}

export async function updatePlanDetails(
  db: Db,
  planId: string,
  patch: { name?: string; eventDate?: Date; slugPrefix?: string | null; upperTargetSize?: number | null },
): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['draft', 'roster_frozen', 'pools_ready', 'underway'], 'edit this plan');
  if (patch.upperTargetSize !== undefined && plan.status !== 'draft') {
    throw new EventPlanStateError('Unfreeze the roster before changing the Upper division size.');
  }
  if (patch.eventDate !== undefined) {
    // The event date is what makes the four brackets one club night. Once any
    // of them is registered the date lives on a tournament row too, and moving
    // only this copy would split the night in the ratings.
    await assertNoAttachedBracket(
      db,
      planId,
      'Brackets are already registered under this event date. Detach them before moving the event.',
    );
  }
  await db
    .update(eventPlans)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.eventDate !== undefined ? { eventDate: patch.eventDate } : {}),
      ...(patch.slugPrefix !== undefined ? { slugPrefix: patch.slugPrefix } : {}),
      ...(patch.upperTargetSize !== undefined ? { upperTargetSize: patch.upperTargetSize } : {}),
      updatedAt: new Date(),
    })
    .where(eq(eventPlans.id, planId));
}

/** Add rows to a draft roster — the person who turns up after the paste. */
export async function addPlanRows(db: Db, planId: string, text: string): Promise<number> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['draft'], 'add roster rows');
  const { ranking } = await loadRanking(db);
  const parsed = parseRosterText(text);
  if (parsed.length === 0) return 0;
  const resolved = await resolveRoster(db, parsed, ranking);

  const [{ maxLine } = { maxLine: 0 }] = await db
    .select({ maxLine: sql<number>`coalesce(max(${eventPlanEntries.sourceLineNumber}), 0)` })
    .from(eventPlanEntries)
    .where(eq(eventPlanEntries.eventPlanId, planId));

  const taken = new Set(
    (
      await db
        .select({ playerId: eventPlanEntries.playerId })
        .from(eventPlanEntries)
        .where(eq(eventPlanEntries.eventPlanId, planId))
    )
      .map((row) => row.playerId)
      .filter((id): id is string => id !== null),
  );

  await db.insert(eventPlanEntries).values(
    resolved.map((row, index) => {
      // A row that resolves to somebody already on the roster comes in unlinked
      // rather than violating the per-plan unique index: the admin then sees a
      // duplicate to remove instead of a paste that failed wholesale.
      const duplicate = row.playerId !== null && taken.has(row.playerId);
      if (row.playerId && !duplicate) taken.add(row.playerId);
      return {
        eventPlanId: planId,
        sourceLineNumber: Number(maxLine) + index + 1,
        rawInput: row.rawInput,
        cleanedName: row.cleanedName,
        companyId: row.companyId,
        playerId: duplicate ? null : row.playerId,
        resolutionMethod: duplicate ? ('unresolved' as const) : row.method,
        divisionPreference: 'auto' as const,
      };
    }),
  );
  return resolved.length;
}

export async function updateEntry(
  db: Db,
  planId: string,
  entryId: string,
  patch: {
    playerId?: string | null;
    divisionPreference?: DivisionPreference;
    /** How the player was chosen; only meaningful alongside `playerId`. */
    resolutionMethod?: 'manual' | 'new';
  },
): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  // Draft only, pins included. A pin changes nothing until the split is
  // recomputed, and the split can only be recomputed by unfreezing — so
  // accepting a pin against a frozen plan would let an admin set something that
  // visibly does not take effect, which is worse than refusing it.
  assertStatus(plan.status, ['draft'], 'edit a roster row');

  if (patch.playerId) {
    const clash = await db
      .select({ id: eventPlanEntries.id })
      .from(eventPlanEntries)
      .where(and(eq(eventPlanEntries.eventPlanId, planId), eq(eventPlanEntries.playerId, patch.playerId)));
    if (clash.some((row) => row.id !== entryId)) {
      throw new EventPlanStateError('That player is already on another row of this roster.');
    }
  }

  await db
    .update(eventPlanEntries)
    .set({
      ...(patch.playerId !== undefined
        ? {
            playerId: patch.playerId,
            resolutionMethod: patch.playerId === null ? 'unresolved' : (patch.resolutionMethod ?? 'manual'),
          }
        : {}),
      ...(patch.divisionPreference !== undefined ? { divisionPreference: patch.divisionPreference } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(eventPlanEntries.eventPlanId, planId), eq(eventPlanEntries.id, entryId)));
}

export async function removeEntry(db: Db, planId: string, entryId: string): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['draft'], 'remove a roster row');
  await db
    .delete(eventPlanEntries)
    .where(and(eq(eventPlanEntries.eventPlanId, planId), eq(eventPlanEntries.id, entryId)));
}

/**
 * Freeze the ranking snapshot and compute the divisions.
 *
 * One transaction, deliberately: a partial freeze — some rows carrying last
 * week's rank, some carrying today's — would be a plan nobody could reason
 * about, and the failure would be silent because every row looks individually
 * fine.
 */
export async function freezeRoster(db: Db, planId: string): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['draft'], 'freeze the roster');

  const view = await getPlan(db, planId);
  if (!view) throw new EventPlanStateError('That event plan no longer exists.');
  if (view.issues.blocking.length > 0) throw new EventPlanValidationError(view.issues.blocking);

  const { recomputeId, ranking } = await loadRanking(db);
  const candidates: DivisionCandidate[] = view.entries.map((entry) => ({
    entryId: entry.id,
    playerId: entry.playerId!,
    divisionPreference: entry.divisionPreference,
    snapshotRank: ranking.get(entry.playerId!)?.rank ?? null,
    sourceLineNumber: entry.sourceLineNumber,
  }));
  const placements = assignDivisions(candidates, {
    upperTargetSize: plan.upperTargetSize,
    poolSize: plan.poolSize,
  });

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const placement of placements) {
      const rating = ranking.get(placement.playerId);
      await tx
        .update(eventPlanEntries)
        .set({
          assignedDivision: placement.division,
          divisionSeed: placement.seed,
          snapshotRank: rating?.rank ?? null,
          snapshotScore: rating?.conservativeRating ?? null,
          updatedAt: now,
        })
        .where(eq(eventPlanEntries.id, placement.entryId));
    }
    await tx
      .update(eventPlans)
      .set({
        status: 'roster_frozen',
        rankingSnapshotAt: now,
        rankingRecomputeId: recomputeId,
        updatedAt: now,
      })
      .where(eq(eventPlans.id, planId));
  });
}

/**
 * Reopen the roster. Refuses once a bracket exists remotely: at that point the
 * seeds are not this app's to change, and quietly recomputing them would leave
 * the plan disagreeing with the bracket people are actually playing.
 */
async function unfreezeRosterUnlocked(db: Db, planId: string): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['roster_frozen', 'pools_ready'], 'unfreeze the roster');
  await assertNoAttachedBracket(
    db,
    planId,
    'A Challonge bracket is already attached to this plan. Detach it before reopening the roster.',
  );

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(eventPlanEntries)
      .set({ assignedDivision: null, divisionSeed: null, snapshotRank: null, snapshotScore: null, updatedAt: now })
      .where(eq(eventPlanEntries.eventPlanId, planId));
    await tx.delete(eventPlanPoolPlacements).where(eq(eventPlanPoolPlacements.eventPlanId, planId));
    await tx
      .update(eventPlans)
      .set({ status: 'draft', rankingSnapshotAt: null, rankingRecomputeId: null, updatedAt: now })
      .where(eq(eventPlans.id, planId));
  });
}

/** Replace one division's seed order. Pools are re-derived from it. */
async function reorderDivisionUnlocked(
  db: Db,
  planId: string,
  division: Division,
  orderedEntryIds: readonly string[],
): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['roster_frozen', 'pools_ready'], 'reorder a division');
  await assertNoAttachedBracket(
    db,
    planId,
    'A Challonge bracket is already attached to this plan, so its seeds are no longer this app’s to change. Detach it first.',
  );

  const rows = await db
    .select({ id: eventPlanEntries.id })
    .from(eventPlanEntries)
    .where(
      and(eq(eventPlanEntries.eventPlanId, planId), eq(eventPlanEntries.assignedDivision, division)),
    );
  const expected = new Set(rows.map((row) => row.id));
  if (orderedEntryIds.length !== expected.size || orderedEntryIds.some((id) => !expected.has(id))) {
    throw new EventPlanStateError(
      `Expected exactly the ${expected.size} entrants of the ${division} division, in order.`,
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    // Two passes through a negative range: the (plan, division, seed) index is
    // unique, so shuffling in place would collide with a seed not yet moved.
    for (const [index, entryId] of orderedEntryIds.entries()) {
      await tx
        .update(eventPlanEntries)
        .set({ divisionSeed: -(index + 1), updatedAt: now })
        .where(eq(eventPlanEntries.id, entryId));
    }
    for (const [index, entryId] of orderedEntryIds.entries()) {
      await tx
        .update(eventPlanEntries)
        .set({ divisionSeed: index + 1, updatedAt: now })
        .where(eq(eventPlanEntries.id, entryId));
    }
  });
}

/**
 * Mark the pools generated.
 *
 * There is nothing to store: a pool is a pure function of the frozen division
 * seeds (`stripeIntoPools`), so writing the membership out again would create a
 * second copy that a later reorder could leave disagreeing with the first. What
 * this does is move the plan's state on, which is what the pool cards, the
 * exports and the placement worksheet key off.
 */
async function generatePoolsUnlocked(db: Db, planId: string): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['roster_frozen', 'pools_ready'], 'generate pools');
  const view = await getPlan(db, planId);
  if (!view) throw new EventPlanStateError('That event plan no longer exists.');
  for (const division of view.divisions) {
    if (division.size === 0 || division.pools.length === 0) {
      throw new EventPlanStateError(`The ${division.division} division does not divide into pools yet.`);
    }
  }
  await db
    .update(eventPlans)
    .set({ status: 'pools_ready', updatedAt: new Date() })
    .where(eq(eventPlans.id, planId));
}

export interface PoolPlacementInput {
  poolIndex: number;
  /** playerId in finishing order; index 0 is first place. */
  playerIdsInOrder: string[];
  expectedMatchRevisions?: Array<{id:string;revision:number}>;
  expectedPlacementRevision?: string;
}

/** Record the confirmed 1-4 for one division's pools. */
async function savePoolPlacementsUnlocked(
  db: Db,
  planId: string,
  division: Division,
  pools: readonly PoolPlacementInput[],
): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['pools_ready', 'underway'], 'record pool results');
  const view = await getPlan(db, planId);
  const divisionView = view?.divisions.find((entry) => entry.division === division);
  if (!divisionView || divisionView.pools.length === 0) {
    throw new EventPlanStateError(`The ${division} division has no pools yet.`);
  }

  for (const pool of pools) {
    const operational=await db.select().from(eventMatches).where(and(eq(eventMatches.eventPlanId,planId),eq(eventMatches.division,division),eq(eventMatches.stage,'group'),eq(eventMatches.poolIndex,pool.poolIndex)));
    if(operational.length||pool.expectedMatchRevisions?.length) {
      const expectedRevisions=pool.expectedMatchRevisions;
      if(pool.expectedPlacementRevision!==divisionView.pools.find(p=>p.poolIndex===pool.poolIndex)?.placementRevision)throw new EventPlanStateError('Pool placements changed since this worksheet was loaded. Refresh before confirming.');
      if(!expectedRevisions||expectedRevisions.length!==operational.length||new Set(expectedRevisions.map(m=>m.id)).size!==operational.length||operational.some(m=>!expectedRevisions.some(e=>e.id===m.id&&e.revision===m.revision)))throw new EventPlanStateError('Pool matches changed since this worksheet was loaded. Refresh and review the finishing order before confirming.');
      const withdrawnIds=new Set(divisionView.pools.flatMap(p=>p.members.filter(m=>m.withdrawn).map(m=>m.playerId)));
      if(operational.some(m=>m.status!=='complete'&&!(m.player1Id&&m.player2Id&&withdrawnIds.has(m.player1Id)&&withdrawnIds.has(m.player2Id))))throw new EventPlanStateError('Record every pool result, including explicit withdrawal forfeits, before confirming its finishing order.');
    }
    const expected = divisionView.pools.find((entry) => entry.poolIndex === pool.poolIndex);
    if (!expected) throw new EventPlanStateError(`Pool ${pool.poolIndex + 1} is not in the ${division} division.`);
    const members = new Set(expected.members.map((member) => member.playerId));
    const given = new Set(pool.playerIdsInOrder);
    if (
      pool.playerIdsInOrder.length !== members.size ||
      given.size !== members.size ||
      [...given].some((playerId) => !members.has(playerId))
    ) {
      throw new EventPlanStateError(
        `Pool ${poolLabel(pool.poolIndex)} needs each of its ${members.size} entrants exactly once.`,
      );
    }
  }

  const consolation = view?.brackets.find((bracket) => bracket.division === division && bracket.stage === 'consolation');
  if (consolation?.challongeSlug) {
    throw new EventPlanStateError('Consolation is already attached. Detach and reconcile that bracket before correcting pool placements; its entrants and seeds may change.');
  }
  if (new Set(pools.map((pool) => pool.poolIndex)).size !== pools.length) {
    throw new EventPlanStateError('Submit each pool only once.');
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const pool of pools) {
      await tx
        .delete(eventPlanPoolPlacements)
        .where(
          and(
            eq(eventPlanPoolPlacements.eventPlanId, planId),
            eq(eventPlanPoolPlacements.division, division),
            eq(eventPlanPoolPlacements.poolIndex, pool.poolIndex),
          ),
        );
      await tx.insert(eventPlanPoolPlacements).values(
        pool.playerIdsInOrder.map((playerId, index) => ({
          eventPlanId: planId,
          division,
          poolIndex: pool.poolIndex,
          playerId,
          place: index + 1,
          source: 'manual' as const,
        })),
      );
    }
    if (plan.status === 'pools_ready') {
      await tx.update(eventPlans).set({ status: 'underway', updatedAt: now }).where(eq(eventPlans.id, planId));
    }
  });
}

/**
 * Attach a Challonge bracket to one of the plan's four slots, registering the
 * tournament if it is not registered already.
 *
 * The event date comes from the plan and is written as a manual override, which
 * is the whole point: rating chronology groups brackets by event date
 * (`eventKeyOf`), so four brackets sharing one date are one club night. The
 * rookie flag is deliberately never set — Upper and Lower are competitive
 * divisions, and marking Lower as the rookie bracket would quietly change what
 * the club's own history means.
 */
async function attachBracketUnlocked(
  db: Db,
  planId: string,
  division: Division,
  stage: BracketStage,
  slugOrUrl: string,
): Promise<{ tournamentId: string; slug: string }> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['roster_frozen', 'pools_ready', 'underway'], 'attach a bracket');
  const slug = normalizeTournamentId(slugOrUrl);

  const conflict = await db
    .select({ id: eventPlanBrackets.id, eventPlanId: eventPlanBrackets.eventPlanId, division: eventPlanBrackets.division, stage: eventPlanBrackets.stage })
    .from(eventPlanBrackets)
    .where(eq(eventPlanBrackets.challongeSlug, slug));
  if (conflict.some((row) => row.eventPlanId !== planId || row.division !== division || row.stage !== stage)) {
    const other = conflict[0]!;
    throw new EventPlanStateError(`${slug} is already attached to an event plan's ${other.division} ${other.stage}.`);
  }

  const [existing] = await db.select().from(tournaments).where(eq(tournaments.challongeSlug, slug));
  let tournamentId: string;
  if (existing) {
    tournamentId = existing.id;
    await db
      .update(tournaments)
      .set({ eventDate: plan.eventDate, eventDateManual: true, updatedAt: new Date() })
      .where(eq(tournaments.id, tournamentId));
  } else {
    const [created] = await db
      .insert(tournaments)
      .values({
        challongeSlug: slug,
        name: `${plan.name} — ${divisionLabel(division)} ${stage === 'main' ? 'Main' : 'Consolation'}`,
        eventDate: plan.eventDate,
        eventDateManual: true,
        // Never inferred from the name: `registerTournament` guesses isRookie
        // from the slug, and a division called "lower" must not trip that.
        isRookie: false,
      })
      .returning({ id: tournaments.id });
    tournamentId = created!.id;
  }

  await db
    .update(eventPlanBrackets)
    .set({ challongeSlug: slug, tournamentId, externalState: 'attached', lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(eventPlanBrackets.eventPlanId, planId),
        eq(eventPlanBrackets.division, division),
        eq(eventPlanBrackets.stage, stage),
      ),
    );
  return { tournamentId, slug };
}

/** Unhook a slug from the plan. The tournament row itself is left alone. */
async function detachBracketUnlocked(
  db: Db,
  planId: string,
  division: Division,
  stage: BracketStage,
): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['roster_frozen', 'pools_ready', 'underway'], 'detach a bracket');
  await db
    .update(eventPlanBrackets)
    .set({ challongeSlug: null, tournamentId: null, externalState: 'draft', lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(eventPlanBrackets.eventPlanId, planId),
        eq(eventPlanBrackets.division, division),
        eq(eventPlanBrackets.stage, stage),
      ),
    );
}

/**
 * Close a plan out. `complete` is the organiser saying the night is done and
 * synced; `cancelled` is it never having happened. Both are one-way from the
 * planner's point of view — a closed plan is a record, and reopening one to
 * re-run a night that already rated would be a way to double-count it.
 */
async function closePlanUnlocked(db: Db, planId: string, status: 'complete' | 'cancelled'): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(
    plan.status,
    status === 'complete' ? ['pools_ready', 'underway'] : ['draft', 'roster_frozen', 'pools_ready', 'underway'],
    `mark this plan ${status}`,
  );
  await db.update(eventPlans).set({ status, updatedAt: new Date() }).where(eq(eventPlans.id, planId));
}

export function divisionLabel(division: Division): string {
  return division === 'upper' ? 'Upper' : 'Lower';
}

export async function listPlans(db: Db) {
  const rows = await db
    .select({
      id: eventPlans.id,
      name: eventPlans.name,
      eventDate: eventPlans.eventDate,
      status: eventPlans.status,
      createdAt: eventPlans.createdAt,
      entryCount: sql<number>`(
        select count(*) from ${eventPlanEntries} where ${eventPlanEntries.eventPlanId} = ${eventPlans.id}
      )`,
    })
    .from(eventPlans)
    .orderBy(sql`${eventPlans.eventDate} desc`)
    .limit(50);
  return rows.map((row) => ({
    ...row,
    entryCount: Number(row.entryCount),
    eventDate: row.eventDate.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function deletePlan(db: Db, planId: string): Promise<void> {
  const plan = await loadPlanRow(db, planId);
  assertStatus(plan.status, ['draft', 'cancelled'], 'delete this plan');
  await db.delete(eventPlans).where(eq(eventPlans.id, planId));
}

export async function unfreezeRoster(db: Db, planId: string): Promise<void> {
  return db.transaction(async tx => {
    await tx.select().from(eventPlans).where(eq(eventPlans.id, planId)).for('update');
    if ((await tx.select({id:eventMatches.id}).from(eventMatches).where(eq(eventMatches.eventPlanId, planId)).limit(1)).length) throw new EventPlanStateError('Operational matches already exist. Use attendance changes, or reset an unplayed queue before changing pools.');
    await unfreezeRosterUnlocked(tx, planId);
  });
}

export async function generatePools(db: Db, planId: string): Promise<void> {
  return db.transaction(async tx => {
    await tx.select().from(eventPlans).where(eq(eventPlans.id, planId)).for('update');
    if ((await tx.select({id:eventMatches.id}).from(eventMatches).where(eq(eventMatches.eventPlanId, planId)).limit(1)).length) throw new EventPlanStateError('Operational matches already exist. Use attendance changes, or reset an unplayed queue before changing pools.');
    await generatePoolsUnlocked(tx, planId);
  });
}

export async function reorderDivision(db: Db, planId: string, division: Division, orderedEntryIds: readonly string[]): Promise<void> {
  return db.transaction(async tx => {
    await tx.select().from(eventPlans).where(eq(eventPlans.id, planId)).for('update');
    if ((await tx.select({id:eventMatches.id}).from(eventMatches).where(eq(eventMatches.eventPlanId, planId)).limit(1)).length) throw new EventPlanStateError('Operational matches already exist. Use attendance changes, or reset an unplayed queue before changing pools.');
    await reorderDivisionUnlocked(tx, planId, division, orderedEntryIds);
  });
}

export async function savePoolPlacements(db: Db, planId: string, division: Division, pools: readonly PoolPlacementInput[]):Promise<void> {
  return db.transaction(async tx=>{
    await tx.select().from(eventPlans).where(eq(eventPlans.id,planId)).for('update');
    return savePoolPlacementsUnlocked(tx, planId, division, pools);
  });
}

export async function attachBracket(db: Db, planId: string, division: Division, stage: BracketStage, slugOrUrl:string):Promise<{tournamentId:string;slug:string}> {
  return db.transaction(async tx=>{
    await tx.select().from(eventPlans).where(eq(eventPlans.id,planId)).for('update');
    return attachBracketUnlocked(tx, planId, division, stage, slugOrUrl);
  });
}

export async function detachBracket(db: Db, planId: string, division: Division, stage: BracketStage):Promise<void> {
  return db.transaction(async tx=>{
    await tx.select().from(eventPlans).where(eq(eventPlans.id,planId)).for('update');
    return detachBracketUnlocked(tx, planId, division, stage);
  });
}

export async function closePlan(db: Db, planId: string, status:'complete'|'cancelled'):Promise<void> {
  return db.transaction(async tx=>{
    await tx.select().from(eventPlans).where(eq(eventPlans.id,planId)).for('update');
    return closePlanUnlocked(tx, planId, status);
  });
}
