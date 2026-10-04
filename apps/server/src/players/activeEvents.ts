import { TRPCError } from '@trpc/server';
import { and, eq, inArray, or } from 'drizzle-orm';
import {
  eventMatches,
  eventPlanEntries,
  eventPlans,
  nativeLiveHandoffs,
  type Db,
} from '@smashclub/db';
import type { NativeRuntime } from '../tournament/runtime';

/** Frozen live identities are checked against the authority that owns each event. */
export async function requireInactiveIdentities(db: Db, ids: string[], runtime?: NativeRuntime) {
  const handoffs = await db.select().from(nativeLiveHandoffs);
  const owned = new Set(handoffs.map((h) => h.eventPlanId));
  if (owned.size && !runtime)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The native tournament runtime is required to check active identities.',
    });
  const activeNames: string[] = [];
  for (const handoff of handoffs) {
    await runtime!.transfer(handoff.eventPlanId);
    const state = await runtime!.state(handoff.eventPlanId);
    if (
      !['finalized', 'cancelled'].includes(state.lifecycle) &&
      state.entrants.some((e) => ids.includes(e.playerId))
    )
      activeNames.push(state.baseline!.name);
  }
  const activeStatuses = ['roster_frozen', 'pools_ready', 'underway'] as const;
  const rosterEvents = await db
    .select({ id: eventPlans.id, name: eventPlans.name })
    .from(eventPlans)
    .innerJoin(eventPlanEntries, eq(eventPlanEntries.eventPlanId, eventPlans.id))
    .where(
      and(inArray(eventPlans.status, [...activeStatuses]), inArray(eventPlanEntries.playerId, ids)),
    );
  const matchEvents = await db
    .select({ id: eventPlans.id, name: eventPlans.name })
    .from(eventPlans)
    .innerJoin(eventMatches, eq(eventMatches.eventPlanId, eventPlans.id))
    .where(
      and(
        inArray(eventPlans.status, [...activeStatuses]),
        or(inArray(eventMatches.player1Id, ids), inArray(eventMatches.player2Id, ids)),
      ),
    );
  activeNames.push(
    ...[...rosterEvents, ...matchEvents].filter((e) => !owned.has(e.id)).map((e) => e.name),
  );
  if (activeNames.length)
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Cannot merge players while either identity is used by active event "${activeNames[0]}". Finish or cancel the event before merging.`,
    });
}
