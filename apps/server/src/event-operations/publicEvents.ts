import { desc, eq, sql } from 'drizzle-orm';
import { eventOperationSettings, eventPlans, type Db } from '@smashclub/db';

/** Public event discovery contains no roster drafts, operator accounts or guest credentials. */
export async function publicEventNights(db: Db) {
  const events = await db.select({ id: eventPlans.id, name: eventPlans.name, eventDate: eventPlans.eventDate, status: eventPlans.status, bracketMode: eventPlans.bracketMode })
    .from(eventPlans).innerJoin(eventOperationSettings, eq(eventOperationSettings.eventPlanId, eventPlans.id))
    .where(eq(eventOperationSettings.published, true))
    .orderBy(sql`case when ${eventPlans.status} in ('complete', 'cancelled') then 1 else 0 end`, desc(eventPlans.eventDate), eventPlans.id).limit(50);
  return events.map(event => ({ ...event, eventDate: event.eventDate.toISOString() }));
}
