import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventMatchAudit, eventMatches, eventOperationSettings, eventPlans, eventPoolSchedules, eventStations, eventWithdrawals, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';
import { lockEvent } from './service';
import { validateGuestSession } from './guests';
import { loadStationQueues } from './queue';
import { matchAvailability } from './availability';

export interface PoolStartInput { planId: string; matchId: string; stationId: string; expectedRevision: number }
const conflict = (message: string): never => { throw new TRPCError({ code: 'CONFLICT', message }); };

/** Caller holds the event lock; this policy never grants correction/forfeit authority. */
export async function canAutoAcceptPoolScore(db: Db, match: typeof eventMatches.$inferSelect) {
  if (match.stage !== 'group' || match.status !== 'playing' || match.poolIndex === null || !match.stationId) return false;
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, match.eventPlanId));
  if (plan?.bracketMode !== 'native') return false;
  const [pool] = await db.select().from(eventPoolSchedules).where(and(eq(eventPoolSchedules.eventPlanId, match.eventPlanId), eq(eventPoolSchedules.division, match.division), eq(eventPoolSchedules.poolIndex, match.poolIndex)));
  return !!(pool?.active && pool.selfRun && pool.autoAcceptScores && pool.stationIds.includes(match.stationId));
}

export async function startPoolMatch(db: Db, actor: SessionUser | null, input: PoolStartInput & { sessionToken?: string }, now = Date.now()) {
  return db.transaction(async tx => {
    const plan = await lockEvent(tx, input.planId);
    let guestSessionId: string | null = null;
    if (actor) {
      const [settings] = await tx.select().from(eventOperationSettings).where(eq(eventOperationSettings.eventPlanId, input.planId));
      if (!settings?.published || !settings.playerReports) throw new TRPCError({ code: 'FORBIDDEN', message: 'Attendee match control is unavailable for this event.' });
    } else {
      if (!input.sessionToken) throw new TRPCError({ code: 'FORBIDDEN', message: 'Scan the event QR code first.' });
      guestSessionId = (await validateGuestSession(tx, { planId: input.planId, sessionToken: input.sessionToken }, now)).id;
    }
    if (plan.bracketMode !== 'native' || !['pools_ready', 'underway'].includes(plan.status)) conflict('Self-service is available only for native pools in an open event.');
    const [match] = await tx.select().from(eventMatches).where(and(eq(eventMatches.id, input.matchId), eq(eventMatches.eventPlanId, input.planId)));
    if (!match || match.revision !== input.expectedRevision || match.stage !== 'group' || match.status !== 'ready' || match.poolIndex === null) conflict('This match changed or is unavailable. Refresh the station queue.');
    const schedules = await tx.select().from(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId, input.planId));
    const pool = schedules.find(p => p.division === match!.division && p.poolIndex === match!.poolIndex);
    if (!pool?.selfRun || !pool.active || !pool.stationIds.includes(input.stationId)) conflict('This pool is not enabled for self-service at that station.');
    const queues = await loadStationQueues(tx, input.planId);
    if (!queues.stationQueues.some(q => q.stationId === input.stationId && q.nextMatchId === match!.id)) conflict('Only the next queued match can start at this station. Refresh the queue.');
    const withdrawn = await tx.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, input.planId));
    if (withdrawn.some(w => [match!.player1Id, match!.player2Id].includes(w.playerId))) conflict('A player has withdrawn. Ask an organiser to resolve this match.');
    const matches = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, input.planId));
    const stations = await tx.select().from(eventStations).where(eq(eventStations.eventPlanId, input.planId));
    const availability = matchAvailability({ ...match!, stationId: input.stationId }, matches, stations, schedules);
    if (!availability.canStart) conflict(availability.reasons.map(r => r.message).join(' '));
    const [updated] = await tx.update(eventMatches).set({ stationId: input.stationId, status: 'playing', revision: match!.revision + 1 }).where(and(eq(eventMatches.id, match!.id), eq(eventMatches.revision, input.expectedRevision))).returning();
    if (!updated) conflict('Another attendee started this match. Refresh the queue.');
    await tx.insert(eventMatchAudit).values({ eventPlanId: input.planId, matchId: match!.id, userId: actor?.id ?? null, guestSessionId, action: 'self_service_started', before: match!, after: updated! });
    return updated!;
  });
}
