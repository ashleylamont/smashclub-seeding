import { eq } from 'drizzle-orm';
import {
  eventMatches,
  eventOperationSettings,
  eventPlans,
  eventPlanEntries,
  eventStations,
  nativeLiveHandoffs,
  players,
  eventPoolSchedules,
  playerRatings,
  recomputes,
  type Db,
} from '@smashclub/db';
import type { SessionUser } from '../auth';
import { softLockPools } from '../event-operations/attendance';
import { requireOperator } from '../event-operations/access';
import { getPlan } from '../event-planner/plans';
import { Baseline, type TournamentBaseline } from './schemas';
import { stableId, TournamentConflict } from './domain';
import { getGlickoSettings } from '../settings';

/** SQL commit is the ownership boundary; Act append can safely be retried later. */
export async function stageNativeBaseline(
  db: Db,
  actor: SessionUser,
  planId: string,
): Promise<TournamentBaseline> {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(eventPlans)
      .where(eq(eventPlans.id, planId))
      .for('update');
    if (!plan || plan.bracketMode !== 'native')
      throw new TournamentConflict('Choose an unplayed native event.');
    await requireOperator(tx, planId, actor);
    const [prior] = await tx
      .select()
      .from(nativeLiveHandoffs)
      .where(eq(nativeLiveHandoffs.eventPlanId, planId));
    if (prior) return Baseline.parse(prior.baseline);
    if (plan.softLockedAt)
      throw new TournamentConflict(
        'Existing soft-locked events need an explicit historical adoption policy.',
      );
    await softLockPools(tx, actor, planId);
    const view = (await getPlan(tx, planId))!;
    const entries = await tx
      .select()
      .from(eventPlanEntries)
      .where(eq(eventPlanEntries.eventPlanId, planId));
    const names = new Map((await tx.select().from(players)).map((p) => [p.id, p.canonicalName]));
    const rows = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
    const stations = await tx
      .select()
      .from(eventStations)
      .where(eq(eventStations.eventPlanId, planId));
    const schedules = await tx
      .select()
      .from(eventPoolSchedules)
      .where(eq(eventPoolSchedules.eventPlanId, planId));
    const [settings] = await tx
      .select()
      .from(eventOperationSettings)
      .where(eq(eventOperationSettings.eventPlanId, planId));
    const ratingSettings = await getGlickoSettings(tx);
    const rankingFit = plan.rankingRecomputeId
      ? (await tx.select().from(recomputes).where(eq(recomputes.id, plan.rankingRecomputeId)))[0]
      : null;
    const rankingInputs = plan.rankingRecomputeId
      ? await tx
          .select({
            playerId: playerRatings.playerId,
            rank: playerRatings.rank,
            skillRating: playerRatings.skillRating,
            skillSd: playerRatings.skillSd,
            conservativeRating: playerRatings.conservativeRating,
            rating: playerRatings.rating,
            rd: playerRatings.rd,
            vol: playerRatings.vol,
          })
          .from(playerRatings)
          .where(eq(playerRatings.recomputeId, plan.rankingRecomputeId))
      : [];
    const poolId = (division: string, index: number) =>
      stableId(`${planId}:pool:${division}:${index}`);
    const baseline = Baseline.parse({
      version: 1,
      planId,
      name: plan.name,
      eventDate: plan.eventDate.getTime(),
      capturedAt: Date.now(),
      capturedBy: actor.id,
      rankingRecomputeId: plan.rankingRecomputeId,
      rankingSnapshotAt: plan.rankingSnapshotAt?.getTime() ?? null,
      ratingContext: {
        settingsVersion: ratingSettings.version,
        settings: ratingSettings.glicko,
        rankingModel: rankingFit?.model ?? null,
        rankingFitSettings: rankingFit?.settingsSnapshot ?? null,
        inputs: rankingInputs.filter((input) => entries.some((e) => e.playerId === input.playerId)),
      },
      poolSize: plan.poolSize,
      upperTargetSize: plan.upperTargetSize,
      entrants: entries.map((e) => ({
        id: e.id,
        playerId: e.playerId,
        name: names.get(e.playerId!),
        division: e.assignedDivision,
        seed: e.divisionSeed,
        snapshotRank: e.snapshotRank,
        snapshotScore: e.snapshotScore,
        availability: 'available',
        revision: 0,
      })),
      pools: view.divisions.flatMap((d) =>
        d.pools.map((p) => {
          const schedule = schedules.find(
            (s) => s.division === d.division && s.poolIndex === p.poolIndex,
          );
          return {
            id: poolId(d.division, p.poolIndex),
            division: d.division,
            index: p.poolIndex,
            entrantIds: p.members.map((m) => m.playerId),
            order: null,
            revision: 0,
            active: schedule?.active ?? true,
            stationIds: schedule?.stationIds ?? [],
            selfRun: schedule?.selfRun ?? false,
            autoAcceptScores: schedule?.autoAcceptScores ?? false,
          };
        }),
      ),
      matches: rows
        .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
        .map((m, slot) => ({
          id: m.id,
          sourceKey: m.sourceKey,
          division: m.division,
          stage: m.stage,
          poolId: m.poolIndex === null ? null : poolId(m.division, m.poolIndex),
          bracketId: null,
          round: 0,
          slot,
          label: m.label,
          parent1Id: null,
          parent2Id: null,
          player1Id: m.player1Id,
          player2Id: m.player2Id,
          status: m.status,
          outcome: m.outcome,
          score1: m.score1,
          score2: m.score2,
          winnerId: m.winnerId,
          stationId: null,
          revision: 0,
          started: false,
          completedAt: null,
          automaticFromRevision: null,
          resultCommandId: null,
        })),
      stations: stations.map((s) => ({ id: s.id, name: s.name, enabled: true, revision: 0 })),
      settings: {
        published: settings?.published ?? false,
        playerReports: settings?.playerReports ?? false,
        scoreReportingMode: settings?.scoreReportingMode ?? 'to_review',
        capacity: stations.length,
        resourceRevision: 0,
        reportingRevision: 0,
      },
    });
    await tx.insert(nativeLiveHandoffs).values({ eventPlanId: planId, baseline });
    return baseline;
  });
}
