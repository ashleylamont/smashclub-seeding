import { and, eq } from 'drizzle-orm';
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
}

export async function configurePool(db: Db, actor: SessionUser, input: ConfigurePoolInput) {
  return db.transaction(async tx => {
    await lockEvent(tx, input.planId);
    await requireOperator(tx, input.planId, actor);
    const view = await getPlan(tx, input.planId);
    if (!view?.divisions.find(division => division.division === input.division)?.pools.some(pool => pool.poolIndex === input.poolIndex)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose an existing pool.' });
    }
    const stations = await tx.select().from(eventStations).where(eq(eventStations.eventPlanId, input.planId));
    if (new Set(input.stationIds).size !== input.stationIds.length || input.stationIds.some(id => !stations.some(station => station.id === id))) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each station must belong to this event and appear only once.' });
    }
    const [previous] = await tx.select().from(eventPoolSchedules).where(and(eq(eventPoolSchedules.eventPlanId, input.planId), eq(eventPoolSchedules.division, input.division), eq(eventPoolSchedules.poolIndex, input.poolIndex)));
    if (input.expectedRevision !== undefined && input.expectedRevision !== (previous?.revision ?? 0)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Another organiser changed this pool schedule. Refresh before saving.' });
    }
    const playing = await tx.select().from(eventMatches).where(and(eq(eventMatches.eventPlanId, input.planId), eq(eventMatches.division, input.division), eq(eventMatches.poolIndex, input.poolIndex), eq(eventMatches.stage, 'group'), eq(eventMatches.status, 'playing')));
    if (playing.some(match => !input.active || (input.stationIds.length > 0 && (!match.stationId || !input.stationIds.includes(match.stationId))))) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Finish or stop the playing matches before holding this pool or changing their allocated stations.' });
    }
    const [updated] = await tx.insert(eventPoolSchedules).values({ eventPlanId: input.planId, division: input.division, poolIndex: input.poolIndex, active: input.active, stationIds: input.stationIds, revision: (previous?.revision ?? 0) + 1 })
      .onConflictDoUpdate({ target: [eventPoolSchedules.eventPlanId, eventPoolSchedules.division, eventPoolSchedules.poolIndex], set: { active: input.active, stationIds: input.stationIds, revision: (previous?.revision ?? 0) + 1 } }).returning();
    await tx.insert(eventAttendanceAudit).values({ eventPlanId: input.planId, userId: actor.id, action: 'pool_schedule_changed', details: { before: previous ?? null, after: updated } });
    return updated!;
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
