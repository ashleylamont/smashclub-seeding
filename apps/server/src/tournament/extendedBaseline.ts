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
import { Baseline, initialState, type TournamentBaseline } from './schemas';
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
  const pools = view.divisions.flatMap((d) =>
    d.pools.map((p) => ({
      id: stableId(`${plan.id}:pool:${d.division}:${p.poolIndex}`),
      division: d.division,
      index: p.poolIndex,
      entrantIds: p.members.map((m) => m.playerId),
      order: null,
      revision: 0,
      active: true,
      stationIds: [],
      selfRun: false,
      autoAcceptScores: false,
      scheduleRevision: 0,
    })),
  );
  const matches = pools.flatMap((pool) =>
    pool.entrantIds.flatMap((a, i) =>
      pool.entrantIds.slice(i + 1).map((b) => {
        const id = stableId(`${pool.id}:${a}:${b}`);
        return {
          id,
          sourceKey: id,
          division: pool.division,
          stage: 'group' as const,
          poolId: pool.id,
          bracketId: null,
          round: 0,
          slot: 0,
          label: `${plan.structure === 'dual_division' ? pool.division : 'Open'} pool ${pool.index + 1}`,
          parent1Id: null,
          parent2Id: null,
          player1Id: a,
          player2Id: b,
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
      }),
    ),
  );
  const now = Date.now();
  const baseline = Baseline.parse({
    version: 2,
    competitionFormat: plan.competitionFormat,
    structure: plan.structure,
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
    stations: stations.map((s) => ({ id: s.id, name: s.name, enabled: true, revision: 0 })),
    announcements: [],
    prizes: [],
    settings: {
      ...initialState().settings,
      published: settings?.published ?? false,
      playerReports: settings?.playerReports ?? false,
      scoreReportingMode: settings?.scoreReportingMode ?? 'to_review',
      capacity: stations.length,
    },
  });
  await db
    .update(eventPlans)
    .set({ softLockedAt: new Date(now), softLockedBy: actor.id })
    .where(eq(eventPlans.id, plan.id));
  await db.insert(nativeLiveHandoffs).values({ eventPlanId: plan.id, baseline });
  return baseline;
}
