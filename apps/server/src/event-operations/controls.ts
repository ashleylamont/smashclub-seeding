import { activePoolReservations } from './queue';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventAnnouncements, eventAttendanceAudit, eventMatchAudit, eventMatches, eventPoolSchedules, eventStations, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';
import { getPlan } from '../event-planner/plans';
import { lockEvent, requireOperator } from './service';

/** Live game counts are not completed results and never enqueue delivery or ratings. */
export async function updateLiveScore(db: Db, actor: SessionUser, input: { matchId: string; expectedRevision: number; score1: number; score2: number }) {
  if (![input.score1, input.score2].every(score => Number.isInteger(score) && score >= 0 && score <= 5)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Live game counts must be whole numbers from 0 to 5.' });
  }
  return db.transaction(async tx => {
    const [initial] = await tx.select().from(eventMatches).where(eq(eventMatches.id, input.matchId));
    if (!initial) throw new TRPCError({ code: 'NOT_FOUND', message: 'Match not found.' });
    await lockEvent(tx, initial.eventPlanId);
    await requireOperator(tx, initial.eventPlanId, actor);
    const [match] = await tx.select().from(eventMatches).where(eq(eventMatches.id, input.matchId));
    if (!match || match.revision !== input.expectedRevision) throw new TRPCError({ code: 'CONFLICT', message: 'This match changed. Refresh its live score before updating.' });
    if (match.status !== 'playing') throw new TRPCError({ code: 'CONFLICT', message: 'Start the match before updating its live score. Completed results use score correction.' });
    const [updated] = await tx.update(eventMatches).set({
      liveScore1: input.score1, liveScore2: input.score2, revision: match.revision + 1,
      score1: null, score2: null, winnerId: null, outcome: null, resultUpdatedAt: null,
    }).where(eq(eventMatches.id, match.id)).returning();
    await tx.insert(eventMatchAudit).values({ eventPlanId: match.eventPlanId, matchId: match.id, userId: actor.id, action: 'live_score_updated', before: match, after: updated });
    return updated!;
  });
}

export interface ConfigurePoolInput {
  planId: string;
  division: 'upper' | 'lower';
  poolIndex: number;
  active: boolean;
  stationIds: string[];
  expectedRevision?: number;
  selfRun?: boolean;
  autoAcceptScores?: boolean;
}

export async function configurePool(db: Db, actor: SessionUser, input: ConfigurePoolInput) {
  return (await configurePools(db, actor, { planId: input.planId, pools: [input] }))[0]!;
}

/** Validate the final bank allocation once, then apply the entire reviewed wave atomically. */
export async function configurePools(db: Db, actor: SessionUser, input: { planId: string; pools: Array<Omit<ConfigurePoolInput, 'planId'>> }) {
  return db.transaction(async tx => {
    await lockEvent(tx, input.planId);
    await requireOperator(tx, input.planId, actor);
    const view = await getPlan(tx, input.planId);
    const stations = await tx.select().from(eventStations).where(eq(eventStations.eventPlanId, input.planId));
    const previous = await tx.select().from(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId, input.planId));
    const key = (pool: { division: string; poolIndex: number }) => `${pool.division}:${pool.poolIndex}`;
    if (new Set(input.pools.map(key)).size !== input.pools.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose each pool only once.' });
    const changes = input.pools.map(pool => {
      if (!view?.divisions.find(d => d.division === pool.division)?.pools.some(p => p.poolIndex === pool.poolIndex)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose an existing pool.' });
      if (new Set(pool.stationIds).size !== pool.stationIds.length || pool.stationIds.some(id => !stations.some(s => s.id === id))) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each station must belong to this event and appear only once.' });
      const before = previous.find(p => key(p) === key(pool));
      if (pool.expectedRevision !== undefined && pool.expectedRevision !== (before?.revision ?? 0)) throw new TRPCError({ code: 'CONFLICT', message: 'Another organiser changed this pool schedule. Refresh before saving.' });
      const selfRun = pool.selfRun ?? before?.selfRun ?? false;
      const autoAcceptScores = pool.autoAcceptScores ?? before?.autoAcceptScores ?? false;
      if (selfRun && (view.plan.bracketMode !== 'native' || !pool.stationIds.length)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Self-running pools require a native event and at least one allocated station.' });
      if (autoAcceptScores && !selfRun) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Automatic score acceptance requires a self-running pool.' });
      return { eventPlanId: input.planId, division: pool.division, poolIndex: pool.poolIndex, active: pool.active, stationIds: pool.stationIds, selfRun, autoAcceptScores, revision: (before?.revision ?? 0) + 1 };
    });
    const final = [...previous.filter(p => !changes.some(c => key(c) === key(p))), ...changes];
    const matches = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, input.planId));
    const reservations = new Map<string, string>();
    for (const pool of activePoolReservations(matches, final)) for (const stationId of pool.stationIds) {
      if (reservations.has(stationId)) throw new TRPCError({ code: 'CONFLICT', message: 'Active pools cannot reserve the same station. Release or hold the other pool in this update.' });
      reservations.set(stationId, key(pool));
    }
    const playing = matches.filter(match => match.status === 'playing');
    for (const match of playing) {
      const poolKey = match.stage === 'group' && match.poolIndex !== null ? key({ division: match.division, poolIndex: match.poolIndex }) : null;
      const schedule = final.find(p => key(p) === poolKey);
      if (schedule && (!schedule.active || schedule.stationIds.length > 0 && (!match.stationId || !schedule.stationIds.includes(match.stationId))) || match.stationId && reservations.has(match.stationId) && reservations.get(match.stationId) !== poolKey) throw new TRPCError({ code: 'CONFLICT', message: 'Finish or stop the playing matches before changing their allocated stations or reserving an occupied station.' });
    }
    const saved: Array<typeof eventPoolSchedules.$inferSelect> = [];
    for (const change of changes) {
      const [updated] = await tx.insert(eventPoolSchedules).values(change).onConflictDoUpdate({ target: [eventPoolSchedules.eventPlanId, eventPoolSchedules.division, eventPoolSchedules.poolIndex], set: change }).returning();
      saved.push(updated!);
      await tx.insert(eventAttendanceAudit).values({ eventPlanId: input.planId, userId: actor.id, action: 'pool_schedule_changed', details: { before: previous.find(p => key(p) === key(change)) ?? null, after: updated } });
    }
    return saved;
  });
}

export async function publishAnnouncement(db: Db, actor: SessionUser, input: { planId: string; message: string; durationSeconds?: number | null }) {
  return db.transaction(async tx => {
    await lockEvent(tx, input.planId);
    await requireOperator(tx, input.planId, actor);
    const expiresAt = input.durationSeconds == null ? null : new Date(Date.now() + input.durationSeconds * 1000);
    return tx.insert(eventAnnouncements).values({ eventPlanId: input.planId, message: input.message, expiresAt }).returning();
  });
}
