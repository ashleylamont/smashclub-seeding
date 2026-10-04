import { eq } from 'drizzle-orm';
import {
  eventMatches,
  eventOperationSettings,
  eventPlanEntries,
  eventPlans,
  players,
  user,
  type Db,
} from '@smashclub/db';
import type { SessionUser } from '../../src/auth';
import { prepare } from '../../src/event-operations/service';

export const to: SessionUser = {
  id: 'reliability-to',
  role: 'admin',
  name: 'Synthetic TO',
  email: 'to@example.test',
};
export const attendee: SessionUser = {
  id: 'reliability-attendee',
  role: 'user',
  name: 'Synthetic attendee',
  email: 'attendee@example.test',
};
export const other: SessionUser = {
  id: 'reliability-other',
  role: 'user',
  name: 'Other attendee',
  email: 'other@example.test',
};

export async function nativeFixture(db: Db, size = 8) {
  await db.insert(user).values([to, attendee, other]).onConflictDoNothing();
  const entrants = await db
    .insert(players)
    .values(Array.from({ length: size }, (_, i) => ({ canonicalName: `Synthetic entrant ${i}` })))
    .returning();
  const [plan] = await db
    .insert(eventPlans)
    .values({
      name: 'Reliability rehearsal',
      eventDate: new Date('2026-09-10T08:00:00Z'),
      status: 'pools_ready',
      bracketMode: 'native',
    })
    .returning();
  await db.insert(eventPlanEntries).values(
    entrants.map((player, i) => ({
      eventPlanId: plan!.id,
      playerId: player.id,
      sourceLineNumber: i + 1,
      rawInput: player.canonicalName,
      cleanedName: player.canonicalName,
      assignedDivision: i < size / 2 ? ('upper' as const) : ('lower' as const),
      divisionSeed: (i % (size / 2)) + 1,
    })),
  );
  await prepare(db, plan!.id);
  await db
    .update(eventOperationSettings)
    .set({ published: true, playerReports: true })
    .where(eq(eventOperationSettings.eventPlanId, plan!.id));
  return {
    planId: plan!.id,
    entrants,
    matches: await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, plan!.id)),
  };
}

export const scoreInput = (match: typeof eventMatches.$inferSelect, requestId: string) => ({
  matchId: match.id,
  expectedRevision: match.revision,
  requestId,
  score1: 2,
  score2: 1,
  outcome: 'played' as const,
});
