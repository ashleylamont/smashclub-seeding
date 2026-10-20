import { and, asc, eq } from 'drizzle-orm';
import { eventPlanEntries, eventPlans, playerRatings, players, type Db } from '@smashclub/db';
import { publicPlayerName, structureIssues, type TournamentStructure } from '@smashclub/shared';
import { NATURAL_TO_DISPLAY } from '@smashclub/engine';
import { latestRecomputeId } from '../recompute/recompute';
import { getRatingSettings } from '../settings';
import { loadDoublesRatings } from '../recompute/doubles';
import { EventPlanStateError, BRACKET_SLOTS, type PlanView } from './contracts';
import { stripeIntoPools, poolLabel } from './pools';

export const extendedNativePlan = (plan: typeof eventPlans.$inferSelect) =>
  plan.competitionFormat === 'doubles' || plan.structure !== 'dual_division';

/** The legacy transport calls its entrant key playerId; doubles use the entry UUID, never a fabricated player. */
export async function getExtendedNativePlan(
  db: Db,
  plan: typeof eventPlans.$inferSelect,
): Promise<PlanView> {
  const rows = await db
    .select()
    .from(eventPlanEntries)
    .where(eq(eventPlanEntries.eventPlanId, plan.id))
    .orderBy(asc(eventPlanEntries.sourceLineNumber));
  const profiles = new Map((await db.select().from(players)).map((p) => [p.id, p]));
  const recomputeId = await latestRecomputeId(db);
  const ratings = new Map(
    (recomputeId
      ? await db.select().from(playerRatings).where(eq(playerRatings.recomputeId, recomputeId))
      : []
    ).map((r) => [r.playerId, r]),
  );
  const { rating: settings } = await getRatingSettings(db);
  const prior = { rating: 1500, sd: settings.whrPriorSd * NATURAL_TO_DISPLAY };
  const skill = (id: string) => {
    const r = ratings.get(id);
    return r ? { rating: r.rating, sd: r.rd } : prior;
  };
  const pairFit =
    plan.competitionFormat === 'doubles'
      ? await loadDoublesRatings(db, plan.eventDate.getTime())
      : null;
  const entries = rows.map((row) => {
    const members = [
      row.playerId,
      ...(plan.competitionFormat === 'doubles' ? [row.partnerPlayerId] : []),
    ].filter((id): id is string => id !== null);
    const names = members.map((id) => profiles.get(id)).filter((p) => p !== undefined);
    const resolved =
      members.length === (plan.competitionFormat === 'doubles' ? 2 : 1) &&
      names.every((p) => p.status === 'active') &&
      names.length === members.length;
    const pair = members.length === 2 ? ([members[0]!, members[1]!] as const) : null;
    const estimate =
      pair && pairFit
        ? plan.usePairRatings
          ? pairFit.rating(pair, plan.eventDate.getTime() / 86400000)
          : pairFit.baseline(pair, plan.eventDate.getTime() / 86400000)
        : {
            ...skill(members[0] ?? ''),
            conservativeRating: skill(members[0] ?? '').rating - 2 * skill(members[0] ?? '').sd,
          };
    return {
      id: row.id,
      sourceLineNumber: row.sourceLineNumber,
      rawInput: row.rawInput,
      cleanedName: row.cleanedName,
      companyCode: null,
      playerId: resolved ? (plan.competitionFormat === 'doubles' ? row.id : row.playerId) : null,
      primaryPlayerId: row.playerId,
      partnerPlayerId: row.partnerPlayerId,
      teamName: row.teamName,
      memberPlayerIds: members,
      memberNames: names.map((p) => p.canonicalName),
      playerName: names.map((p) => p.canonicalName).join(' / ') || null,
      publicName: row.teamName
        ? `${row.teamName} (${names.map(publicPlayerName).join(' / ')})`
        : names.map(publicPlayerName).join(' / ') || null,
      playerStatus: resolved ? 'active' : null,
      resolutionMethod: row.resolutionMethod,
      divisionPreference: row.divisionPreference,
      assignedDivision: row.assignedDivision,
      snapshotRank: row.snapshotRank,
      snapshotScore: row.snapshotScore,
      snapshotMean: row.snapshotMean,
      snapshotSd: row.snapshotSd,
      divisionSeed: row.divisionSeed,
      currentRank: null,
      currentScore: estimate.conservativeRating,
      currentMean: estimate.rating,
      currentSd: estimate.sd,
      lastPlayedDate: null,
      candidates: [],
    };
  });
  const blocking = structureIssues(plan.structure, entries.length).map((message) => ({
    code: 'structure',
    message,
  }));
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.playerId)
      blocking.push({
        code: 'unresolved_members',
        message: `Resolve every member of entrant ${e.sourceLineNumber}.`,
      });
    for (const member of e.memberPlayerIds) {
      if (seen.has(member))
        blocking.push({
          code: 'duplicate_member',
          message: 'A player can enter only once in a competition.',
        });
      seen.add(member);
    }
  }
  if (plan.structure === 'dual_division') {
    const upper = plan.upperTargetSize ?? Math.ceil(entries.length / 2);
    if (upper < 3 || entries.length - upper < 3)
      blocking.push({
        code: 'division_size',
        message: 'Each division needs at least three entrants.',
      });
    for (const division of ['upper', 'lower'] as const)
      if (
        entries.filter((e) => e.divisionPreference === division).length >
        (division === 'upper' ? upper : entries.length - upper)
      )
        blocking.push({
          code: 'division_pins',
          message: 'Pinned entrants exceed the division size.',
        });
  }
  const divisions = (
    plan.structure === 'dual_division' ? (['upper', 'lower'] as const) : (['upper'] as const)
  ).map((division) => {
    const members = entries
      .filter((e) => e.assignedDivision === division)
      .sort((a, b) => a.divisionSeed! - b.divisionSeed!);
    const pools = members.length
      ? (plan.structure === 'round_robin' ? [members] : stripeIntoPools(members)).map(
          (group, poolIndex) => ({
            poolIndex,
            label: poolLabel(poolIndex),
            members: group.map((e) => ({
              entryId: e.id,
              playerId: e.playerId!,
              name: e.publicName ?? e.cleanedName,
              seed: e.divisionSeed!,
              snapshotRank: e.snapshotRank,
              place: null,
            })),
          }),
        )
      : [];
    return {
      division,
      size: members.length,
      poolCount: pools.length,
      pools,
      consolation: null,
      championship: [],
    };
  });
  return {
    plan: {
      id: plan.id,
      name: plan.name,
      eventDate: plan.eventDate.toISOString(),
      slugPrefix: plan.slugPrefix,
      status: plan.status,
      bracketMode: plan.bracketMode,
      competitionFormat: plan.competitionFormat,
      structure: plan.structure,
      usePairRatings: plan.usePairRatings,
      nativeSeedContext:
        plan.status === 'draft' && pairFit
          ? {
              ...pairFit.provenance,
              usePairRatings: plan.usePairRatings,
              members: entries.flatMap((e) =>
                (e.memberPlayerIds ?? []).map((playerId) => ({
                  playerId,
                  ...pairFit.skillAt(playerId, plan.eventDate.getTime() / 86400000),
                })),
              ),
            }
          : plan.nativeSeedContext,
      historicalAdoption: null,
      upperTargetSize: plan.upperTargetSize,
      poolSize: plan.poolSize,
      softLockedAt: plan.softLockedAt?.toISOString() ?? null,
      softLockedBy: plan.softLockedBy,
      rankingSnapshotAt: plan.rankingSnapshotAt?.toISOString() ?? null,
      createdAt: plan.createdAt.toISOString(),
    },
    entries,
    divisions,
    issues: { blocking, warnings: [] },
    brackets: BRACKET_SLOTS.filter(
      (s) => plan.structure === 'dual_division' || s.division === 'upper',
    ).map((s) => ({
      ...s,
      id: '',
      challongeSlug: null,
      tournamentId: null,
      externalState: 'draft',
      lastError: null,
      tournamentEventDate: null,
      tournamentSyncState: null,
      tournamentIsRookie: null,
      suggestedSlug: '',
    })),
  };
}

export async function freezeExtendedNativePlan(db: Db, planId: string) {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(eventPlans)
      .where(eq(eventPlans.id, planId))
      .for('update');
    if (!plan || plan.status !== 'draft')
      throw new EventPlanStateError('Only a draft roster can be frozen.');
    const view = await getExtendedNativePlan(tx, plan);
    if (view.issues.blocking.length)
      throw new EventPlanStateError(view.issues.blocking.map((i) => i.message).join(' '));
    const nativeSeedContext = view.plan.nativeSeedContext ?? null;
    const ordered = [...view.entries].sort(
      (a, b) => b.currentScore! - a.currentScore! || a.sourceLineNumber - b.sourceLineNumber,
    );
    const upperSize =
      plan.structure === 'dual_division'
        ? (plan.upperTargetSize ?? Math.ceil(ordered.length / 2))
        : ordered.length;
    const auto = ordered.filter((e) => e.divisionPreference === 'auto');
    // Assign pins once, then fill remaining upper places from the strongest auto entrants.
    const upperIds = new Set(
      plan.structure === 'dual_division'
        ? ordered.filter((e) => e.divisionPreference === 'upper').map((e) => e.id)
        : ordered.map((e) => e.id),
    );
    if (plan.structure === 'dual_division')
      for (const e of auto) if (upperIds.size < upperSize) upperIds.add(e.id);
    let upperSeed = 0,
      lowerSeed = 0;
    for (const [index, e] of ordered.entries())
      await tx
        .update(eventPlanEntries)
        .set({
          assignedDivision: upperIds.has(e.id) ? 'upper' : 'lower',
          divisionSeed: upperIds.has(e.id) ? ++upperSeed : ++lowerSeed,
          snapshotRank: index + 1,
          snapshotScore: e.currentScore,
          snapshotMean: e.currentMean,
          snapshotSd: e.currentSd,
        })
        .where(eq(eventPlanEntries.id, e.id));
    await tx
      .update(eventPlans)
      .set({
        status: 'roster_frozen',
        nativeSeedContext,
        rankingSnapshotAt: new Date(),
        rankingRecomputeId: await latestRecomputeId(tx),
      })
      .where(eq(eventPlans.id, planId));
  });
}

export async function validateDraftMembers(db: Db, planId: string) {
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId));
  if (!plan) throw new EventPlanStateError('Event not found.');
  const rows = await db
    .select()
    .from(eventPlanEntries)
    .where(eq(eventPlanEntries.eventPlanId, planId));
  const ids = rows.flatMap((r) =>
    [r.playerId, r.partnerPlayerId].filter((id): id is string => id !== null),
  );
  if (new Set(ids).size !== ids.length)
    throw new EventPlanStateError('A player can enter only once in a competition.');
  if (plan.competitionFormat === 'singles' && rows.some((r) => r.partnerPlayerId))
    throw new EventPlanStateError('Singles entrants cannot have a partner.');
  const profiles = new Map((await db.select().from(players)).map((p) => [p.id, p]));
  if (ids.some((id) => profiles.get(id)?.status !== 'active'))
    throw new EventPlanStateError('Select active player identities.');
}

export async function updateNativeFormat(
  db: Db,
  planId: string,
  structure: TournamentStructure,
  usePairRatings?: boolean,
) {
  await db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(eventPlans)
      .where(eq(eventPlans.id, planId))
      .for('update');
    if (!plan || plan.bracketMode !== 'native' || plan.status !== 'draft')
      throw new EventPlanStateError('Change the native format only while the roster is a draft.');
    await tx
      .update(eventPlans)
      .set({ structure, ...(usePairRatings !== undefined ? { usePairRatings } : {}) })
      .where(and(eq(eventPlans.id, planId), eq(eventPlans.status, 'draft')));
  });
}

export async function addDoublesPair(
  db: Db,
  input: { planId: string; playerId: string; partnerPlayerId: string; teamName: string | null },
) {
  await db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(eventPlans)
      .where(eq(eventPlans.id, input.planId))
      .for('update');
    if (!plan || plan.status !== 'draft' || plan.competitionFormat !== 'doubles')
      throw new EventPlanStateError('Add pairs only to a draft doubles event.');
    const rows = await tx
      .select()
      .from(eventPlanEntries)
      .where(eq(eventPlanEntries.eventPlanId, input.planId));
    const taken = new Set(rows.flatMap((r) => [r.playerId, r.partnerPlayerId]));
    if (
      input.playerId === input.partnerPlayerId ||
      taken.has(input.playerId) ||
      taken.has(input.partnerPlayerId)
    )
      throw new EventPlanStateError('A player can enter only once in a competition.');
    await tx.insert(eventPlanEntries).values({
      eventPlanId: input.planId,
      playerId: input.playerId,
      partnerPlayerId: input.partnerPlayerId,
      teamName: input.teamName,
      sourceLineNumber: Math.max(0, ...rows.map((r) => r.sourceLineNumber)) + 1,
      rawInput: input.teamName ?? 'Doubles pair',
      cleanedName: input.teamName ?? 'Doubles pair',
      resolutionMethod: 'manual',
    });
    await validateDraftMembers(tx, input.planId);
  });
}
