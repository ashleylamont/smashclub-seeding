import { isKnockout } from '@smashclub/shared';
import { instantiateElimination } from './structureAdapter';
import { advance } from './brackets';
import { compileTournament } from '@smashclub/engine';
import { eq } from 'drizzle-orm';
import {
  eventPlans,
  eventStations,
  eventOperationSettings,
  nativeLiveHandoffs,
  playerRatings,
  recomputes,
  type Db,
} from '@smashclub/db';
import type { SessionUser } from '../auth';
import { getExtendedNativePlan } from '../event-planner/nativePlanner';
import { getRatingSettings } from '../settings';
import { Baseline, initialState, type TournamentBaseline, type Match } from './schemas';
import { requireFact, stableId } from './facts';

/** Caller holds the plan row lock. All chosen members, pools, and rating inputs are frozen once. */
export async function stageExtendedNativeBaseline(
  db: Db,
  actor: SessionUser,
  plan: typeof eventPlans.$inferSelect,
): Promise<TournamentBaseline> {
  requireFact(
    plan.status === 'pools_ready' && !plan.softLockedAt,
    'Generate the frozen pools before locking the draw.',
  );
  const view = await getExtendedNativePlan(db, plan);
  requireFact(!view.issues.blocking.length, view.issues.blocking.map((i) => i.message).join(' '));
  const stations = await db
    .select()
    .from(eventStations)
    .where(eq(eventStations.eventPlanId, plan.id));
  const [settings] = await db
    .select()
    .from(eventOperationSettings)
    .where(eq(eventOperationSettings.eventPlanId, plan.id));
  const ratingSettings = await getRatingSettings(db);
  const [fit] = plan.rankingRecomputeId
    ? await db.select().from(recomputes).where(eq(recomputes.id, plan.rankingRecomputeId))
    : [];
  const inputs = plan.rankingRecomputeId
    ? await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.recomputeId, plan.rankingRecomputeId))
    : [];
  const members = new Set(view.entries.flatMap((e) => e.memberPlayerIds ?? []));
  const graph = compileTournament({
    structure: plan.structure,
    options: plan.structureOptions,
    poolSize: plan.poolSize,
    divisions: view.divisions.map((d) => ({
      id: d.division,
      entrantIds: view.entries
        .filter((e) => e.assignedDivision === d.division)
        .sort((a, b) => a.divisionSeed! - b.divisionSeed!)
        .map((e) => e.playerId!),
    })),
  });
  const poolStages = graph.stages.filter((stage) => stage.kind === 'round_robin');
  const pools = poolStages.map((p) => ({
    id: stableId(`${plan.id}:pool:${p.divisionId}:${p.index}`),
    division: p.divisionId === 'lower' ? ('lower' as const) : ('upper' as const),
    index: p.index,
    entrantIds: p.entrantIds,
    order: null,
    revision: 0,
    active: true,
    stationIds: [],
    selfRun: false,
    autoAcceptScores: false,
    scheduleRevision: 0,
  }));
  const poolByStage = new Map(poolStages.map((p, index) => [p.id, pools[index]!]));
  // Symbolic finals stay in the plan graph. Actual finals are chosen only when
  // confirmed pool orders reach the live decision boundary.
  const matches: Match[] = graph.matches
    .filter((m) => poolByStage.has(m.stageId))
    .map((pairing) => {
      const pool = poolByStage.get(pairing.stageId)!;
      const [a, b] = pairing.sides;
      requireFact(
        a.kind === 'entrant' && b.kind === 'entrant',
        'Pool matches require actual entrants.',
      );
      const id = stableId(`${pool.id}:${pairing.meeting}:${a.entrantId}:${b.entrantId}`);
      return {
        id,
        sourceKey: id,
        division: pool.division,
        stage: 'group' as const,
        poolId: pool.id,
        bracketId: null,
        round: pairing.round,
        slot: pairing.slot,
        label: `${plan.structure === 'dual_division' ? pool.division : 'Open'} pool ${pool.index + 1}`,
        parent1Id: null,
        parent2Id: null,
        player1Id: a.entrantId,
        player2Id: b.entrantId,
        status: 'ready' as const,
        outcome: null,
        score1: null,
        score2: null,
        winnerId: null,
        stationId: null,
        revision: 0,
        started: false,
        completedAt: null,
        automaticFromRevision: null,
        resultCommandId: null,
        liveScore1: null,
        liveScore2: null,
        progressRevision: 0,
        blockedReason: null,
      };
    });
  const now = Date.now();
  const brackets = isKnockout(plan.structure)
    ? graph.stages
        .filter((s) => s.kind !== 'round_robin')
        .map((s) => ({
          id: stableId(`${plan.id}:bracket:${s.id}`),
          division: 'upper' as const,
          stage: s.role,
          entrantIds: s.entrants.flatMap((source) =>
            source.kind === 'entrant' ? [source.entrantId] : [],
          ),
        }))
    : [];
  if (isKnockout(plan.structure))
    matches.push(...instantiateElimination(graph.matches, brackets[0]!.id, 'upper', 'main'));

  const baseline = Baseline.parse({
    version: 2,
    competitionFormat: plan.competitionFormat,
    structure: plan.structure,
    structureOptions: plan.structureOptions,
    planId: plan.id,
    name: plan.name,
    eventDate: plan.eventDate.getTime(),
    capturedAt: now,
    capturedBy: actor.id,
    rankingRecomputeId: plan.rankingRecomputeId,
    rankingSnapshotAt: plan.rankingSnapshotAt?.getTime() ?? null,
    ratingContext: {
      ...(plan.nativeSeedContext ? { doubles: plan.nativeSeedContext } : {}),
      settingsVersion: ratingSettings.version,
      settings: { ...ratingSettings.rating, usePairRatings: plan.usePairRatings },
      rankingModel: fit?.model ?? null,
      rankingFitSettings: fit?.settingsSnapshot ?? null,
      inputs: inputs.filter((r) => members.has(r.playerId)),
    },
    poolSize: plan.poolSize,
    upperTargetSize: plan.upperTargetSize,
    entrants: view.entries.map((e) => ({
      id: e.id,
      playerId: e.playerId,
      name: e.playerName,
      memberPlayerIds: e.memberPlayerIds,
      teamName: e.teamName,
      snapshotMean: e.snapshotMean,
      snapshotSd: e.snapshotSd,
      division: e.assignedDivision,
      seed: e.divisionSeed,
      snapshotRank: e.snapshotRank,
      snapshotScore: e.snapshotScore,
      availability: 'available',
      revision: 0,
    })),
    pools,
    matches,
    ...(isKnockout(plan.structure) ? { brackets } : {}),
    stations: stations.map((s) => ({ id: s.id, name: s.name, enabled: true, revision: 0 })),
    announcements: [],
    prizes: [],
    settings: {
      ...initialState().settings,
      ...(!isKnockout(plan.structure) ? { poolOrderPolicy: 'unique_set_wins_v1' as const } : {}),
      published: settings?.published ?? false,
      playerReports: settings?.playerReports ?? false,
      scoreReportingMode: settings?.scoreReportingMode ?? 'to_review',
      capacity: stations.length,
    },
  });
  if (isKnockout(plan.structure))
    advance(
      {
        ...initialState(),
        baseline,
        entrants: baseline.entrants,
        matches: baseline.matches,
        brackets,
      },
      now,
      stableId(`${plan.id}:initial-advancement`),
    );
  await db
    .update(eventPlans)
    .set({ softLockedAt: new Date(now), softLockedBy: actor.id })
    .where(eq(eventPlans.id, plan.id));
  await db.insert(nativeLiveHandoffs).values({ eventPlanId: plan.id, baseline });
  return baseline;
}
