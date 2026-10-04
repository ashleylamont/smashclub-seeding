import { and, eq, sql } from 'drizzle-orm';
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
  eventNativeBrackets,
  eventScoreReports,
  eventWithdrawals,
  eventAnnouncements,
  eventPrizes,
  tournaments,
  eventMatchAudit,
  eventAttendanceAudit,
  nativeResultPublications,
  recomputes,
  type Db,
} from '@smashclub/db';
import type { SessionUser } from '../auth';
import { softLockPools } from '../event-operations/attendance';
import { requireOperator } from '../event-operations/access';
import { getPlan } from '../event-planner/plans';
import { Baseline, LiveState, initialState, type TournamentBaseline } from './schemas';
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
      throw new TournamentConflict('Choose a native event.');
    await requireOperator(tx, planId, actor);
    const [prior] = await tx
      .select()
      .from(nativeLiveHandoffs)
      .where(eq(nativeLiveHandoffs.eventPlanId, planId));
    if (prior)
      return Baseline.parse((prior.baseline as { baseline?: unknown }).baseline ?? prior.baseline);
    const existingMatches = await tx
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.eventPlanId, planId));
    const existingReports = await tx
      .select()
      .from(eventScoreReports)
      .where(eq(eventScoreReports.eventPlanId, planId));
    const legacyBrackets = await tx
      .select()
      .from(eventNativeBrackets)
      .where(eq(eventNativeBrackets.eventPlanId, planId));
    const importing = Boolean(
      legacyBrackets.length ||
      existingReports.length ||
      existingMatches.some(
        (m) =>
          m.status === 'playing' ||
          m.status === 'complete' ||
          m.outcome ||
          m.liveScore1 !== null ||
          m.liveScore2 !== null,
      ) ||
      plan.softLockedAt ||
      ['underway', 'complete', 'cancelled'].includes(plan.status),
    );
    if (!importing) await softLockPools(tx, actor, planId);
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
    const legacyReports = existingReports;
    const withdrawn = await tx
      .select()
      .from(eventWithdrawals)
      .where(eq(eventWithdrawals.eventPlanId, planId));
    const legacyAudit = await tx
      .select()
      .from(eventMatchAudit)
      .where(eq(eventMatchAudit.eventPlanId, planId));
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
        availability: withdrawn.some((w) => w.playerId === e.playerId) ? 'withdrawn' : 'available',
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
            order: p.members.every((m) => m.place !== null)
              ? [...p.members].sort((a, b) => a.place! - b.place!).map((m) => m.playerId)
              : null,
            revision: 0,
            scheduleRevision: schedule?.revision ?? 0,
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
          bracketId: m.nativeBracketId,
          round: m.nativeRound ?? 0,
          slot: m.nativeSlot ?? slot,
          label: m.label,
          parent1Id: m.parent1MatchId,
          parent2Id: m.parent2MatchId,
          player1Id: m.player1Id,
          player2Id: m.player2Id,
          status: m.blockedReason?.startsWith('Both players withdrawn:') ? 'complete' : m.status,
          outcome: m.blockedReason?.startsWith('Both players withdrawn:')
            ? 'no_contest'
            : m.outcome,
          score1: m.score1,
          score2: m.score2,
          winnerId: m.winnerId,
          stationId: m.stationId,
          revision: m.revision,
          started:
            m.status === 'playing' ||
            m.outcome === 'played' ||
            m.liveScore1 !== null ||
            m.liveScore2 !== null ||
            legacyAudit.some(
              (a) =>
                a.matchId === m.id &&
                ((a.before as { status?: string }).status === 'playing' ||
                  (a.after as { status?: string }).status === 'playing'),
            ),
          completedAt: m.resultUpdatedAt?.getTime() ?? null,
          automaticFromRevision:
            legacyReports.find(
              (r) => r.matchId === m.id && r.autoApproved && r.submittedRevision === m.revision - 1,
            )?.submittedRevision ?? null,
          liveScore1: m.liveScore1,
          liveScore2: m.liveScore2,
          blockedReason: m.blockedReason,
          progressRevision: 0,
          resultCommandId: null,
        })),
      stations: stations.map((s) => ({ id: s.id, name: s.name, enabled: true, revision: 0 })),
      announcements: (
        await tx.select().from(eventAnnouncements).where(eq(eventAnnouncements.eventPlanId, planId))
      ).map((a) => ({
        ...a,
        createdAt: a.createdAt.getTime(),
        expiresAt: a.expiresAt?.getTime() ?? null,
      })),
      prizes: await tx.select().from(eventPrizes).where(eq(eventPrizes.eventPlanId, planId)),
      settings: {
        published: settings?.published ?? false,
        playerReports: settings?.playerReports ?? false,
        scoreReportingMode: settings?.scoreReportingMode ?? 'to_review',
        capacity: stations.length,
        resourceRevision: 0,
        reportingRevision: 0,
      },
    });
    if (importing) {
      const imported = LiveState.parse({
        ...initialState(),
        baseline,
        sequence: 1,
        lifecycle:
          plan.status === 'complete'
            ? 'finalized'
            : plan.status === 'cancelled'
              ? 'cancelled'
              : 'locked',
        entrants: baseline.entrants,
        pools: baseline.pools,
        matches: baseline.matches,
        stations: baseline.stations,
        settings: baseline.settings,
        brackets: legacyBrackets.map((b) => ({
          id: b.id,
          division: b.division,
          stage: b.stage,
          entrantIds: b.entrantIds,
        })),
        reports: legacyReports.map((r) => ({
          ...r,
          actorId: r.userId ?? `guest:${r.guestSessionId}`,
          submittedRevision: r.submittedRevision ?? r.expectedRevision,
          createdAt: r.createdAt.getTime(),
        })),
        announcements: baseline.announcements,
        prizes: baseline.prizes,
      });
      if (plan.status === 'complete') {
        const ids = (
          await tx
            .select({ id: tournaments.id })
            .from(tournaments)
            .where(
              and(
                eq(tournaments.provider, 'native'),
                sql`${tournaments.raw}->>'eventPlanId' = ${planId}`,
              ),
            )
        ).map((t) => t.id);
        imported.result = {
          version: 1,
          id: stableId(`${planId}:legacy-result`),
          planId,
          revision: 1,
          name: plan.name,
          eventDate: plan.eventDate.getTime(),
          sealedAt: plan.updatedAt.getTime(),
          entrants: imported.entrants,
          brackets: imported.brackets,
          matches: imported.matches,
          replacesResultId: null,
          replacementReason: null,
        };
        imported.publication = { resultId: imported.result.id, tournamentIds: ids };
      }
      // Preserve original audit as imported evidence; do not invent pre-migration commands.
      const audit = legacyAudit;
      const attendance = await tx
        .select()
        .from(eventAttendanceAudit)
        .where(eq(eventAttendanceAudit.eventPlanId, planId));
      await tx.insert(nativeLiveHandoffs).values({
        eventPlanId: planId,
        baseline: {
          baseline,
          importedState: imported,
          legacyAudit: JSON.parse(JSON.stringify(audit)),
          legacyAttendance: JSON.parse(JSON.stringify(attendance)),
        },
      });
      if (imported.result)
        await tx.insert(nativeResultPublications).values({
          resultId: imported.result.id,
          eventPlanId: planId,
          revision: 1,
          result: imported.result,
          tournamentIds: imported.publication!.tournamentIds,
        });
    } else await tx.insert(nativeLiveHandoffs).values({ eventPlanId: planId, baseline });
    return baseline;
  });
}

export async function migrateLegacyNativePlans(db: Db) {
  const owned = new Set((await db.select().from(nativeLiveHandoffs)).map((h) => h.eventPlanId));
  const plans = (
    await db.select().from(eventPlans).where(eq(eventPlans.bracketMode, 'native'))
  ).filter((p) => !owned.has(p.id) && !p.historicalAdoption);
  if (!plans.length) return;
  const matches = await db.select().from(eventMatches);
  const reports = await db.select().from(eventScoreReports);
  const brackets = await db.select().from(eventNativeBrackets);
  const liveIds = new Set([
    ...brackets.map((b) => b.eventPlanId),
    ...reports.map((r) => r.eventPlanId),
    ...matches
      .filter(
        (m) =>
          m.status === 'playing' ||
          m.status === 'complete' ||
          m.outcome ||
          m.liveScore1 !== null ||
          m.liveScore2 !== null,
      )
      .map((m) => m.eventPlanId),
  ]);
  for (const plan of plans.filter(
    (p) => p.softLockedAt || liveIds.has(p.id) || ['underway', 'complete'].includes(p.status),
  ))
    await stageNativeBaseline(
      db,
      {
        id: 'native-migration',
        name: 'Native state migration',
        email: 'migration@internal',
        role: 'admin',
      },
      plan.id,
    );
}
