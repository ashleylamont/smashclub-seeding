import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventMatches, eventPoolSchedules, eventStations, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';
import { lockEvent, requireOperator } from './service';

export async function saveStation(db: Db, actor: SessionUser, input: { planId: string; id?: string; name: string }) {
  return db.transaction(async tx => {
    await lockEvent(tx, input.planId);
    await requireOperator(tx, input.planId, actor);
    if (!input.id) return tx.insert(eventStations).values({ eventPlanId: input.planId, name: input.name }).returning();
    const updated = await tx.update(eventStations).set({ name: input.name }).where(and(eq(eventStations.id, input.id), eq(eventStations.eventPlanId, input.planId))).returning();
    if (!updated.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Station not found in this event.' });
    return updated;
  });
}

export async function deleteStation(db: Db, actor: SessionUser, input: { planId: string; id: string }) {
  return db.transaction(async tx => {
    await lockEvent(tx, input.planId);
    await requireOperator(tx, input.planId, actor);
    const [station] = await tx.select().from(eventStations).where(and(eq(eventStations.id, input.id), eq(eventStations.eventPlanId, input.planId)));
    if (!station) throw new TRPCError({ code: 'NOT_FOUND', message: 'Station not found in this event.' });
    const matches = await tx.select().from(eventMatches).where(and(eq(eventMatches.eventPlanId, input.planId), eq(eventMatches.stationId, input.id)));
    if (matches.some(match => match.status === 'playing')) throw new TRPCError({ code: 'CONFLICT', message: 'Return the playing match to the queue before deleting this station.' });
    const schedules = await tx.select().from(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId, input.planId));
    for (const schedule of schedules.filter(row => row.stationIds.includes(input.id))) {
      const stationIds = schedule.stationIds.filter(id => id !== input.id);
      await tx.update(eventPoolSchedules).set({ stationIds, selfRun: stationIds.length > 0 && schedule.selfRun, autoAcceptScores: stationIds.length > 0 && schedule.autoAcceptScores, revision: schedule.revision + 1 }).where(eq(eventPoolSchedules.id, schedule.id));
    }
    for (const match of matches) await tx.update(eventMatches).set({ stationId: null, revision: match.revision + 1 }).where(eq(eventMatches.id, match.id));
    await tx.delete(eventStations).where(eq(eventStations.id, input.id));
    return station;
  });
}
