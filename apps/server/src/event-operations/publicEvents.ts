import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  eventOperationSettings,
  eventPlans,
  eventTwitchPromotions,
  nativeLiveHandoffs,
  type Db,
} from '@smashclub/db';
import type { TrpcContext } from '../trpc/trpc';
import { nativeEvent } from '../tournament/api';
import { readSqlSnapshotSource } from './service';
import { publicTwitchPromotion } from './twitchPromotion';

/** Public event discovery contains no roster drafts, operator accounts or guest credentials. */
export async function publicEventNights(db: Db) {
  const events = await db
    .select({
      id: eventPlans.id,
      name: eventPlans.name,
      eventDate: eventPlans.eventDate,
      status: eventPlans.status,
      bracketMode: eventPlans.bracketMode,
      competitionFormat: eventPlans.competitionFormat,
      twitch: eventTwitchPromotions,
      handoff: nativeLiveHandoffs.eventPlanId,
    })
    .from(eventPlans)
    .innerJoin(eventOperationSettings, eq(eventOperationSettings.eventPlanId, eventPlans.id))
    .leftJoin(nativeLiveHandoffs, eq(nativeLiveHandoffs.eventPlanId, eventPlans.id))
    .leftJoin(eventTwitchPromotions, eq(eventTwitchPromotions.eventPlanId, eventPlans.id))
    .where(and(eq(eventOperationSettings.published, true), isNull(eventPlans.deletedAt)))
    .orderBy(
      sql`case when ${eventPlans.status} in ('complete', 'cancelled') then 1 else 0 end`,
      desc(eventPlans.eventDate),
      eventPlans.id,
    )
    .limit(50);
  const now = Date.now();
  return events.map(({ twitch, handoff, ...event }) => ({
    ...event,
    ...publicTwitchPromotion(twitch, !handoff && event.status === 'underway', now),
    eventDate: event.eventDate.toISOString(),
    drawPaused: false,
  }));
}

export async function resolvePublicEventCode(ctx: TrpcContext, code: number) {
  const unavailable = () => new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
  const [plan] = await ctx.db
    .select({ id: eventPlans.id, handoff: nativeLiveHandoffs.eventPlanId })
    .from(eventPlans)
    .leftJoin(nativeLiveHandoffs, eq(nativeLiveHandoffs.eventPlanId, eventPlans.id))
    .where(and(eq(eventPlans.publicCode, code), isNull(eventPlans.deletedAt)));
  if (!plan) throw unavailable();
  try {
    // Guessable codes must check SQL publication before a canonical read can hand off ownership.
    if (plan.handoff) {
      const api = await nativeEvent(ctx, plan.id);
      if (!api) throw unavailable();
      await api.publishedState();
    } else {
      await readSqlSnapshotSource(ctx.db, plan.id);
    }
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') throw unavailable();
    throw error;
  }
  return { planId: plan.id };
}
