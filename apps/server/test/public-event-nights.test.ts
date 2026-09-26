import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventOperationSettings, eventPlans } from '@smashclub/db';
import { publicEventNights } from '../src/event-operations/publicEvents';
import { createTestDb } from './helpers/testDb';

it('lists only explicitly published events, prioritizes open nights and removes unpublished entries immediately', async () => {
  const { db, close } = await createTestDb();
  try {
    const plans = await db.insert(eventPlans).values([
      { name: 'Private draft', eventDate: new Date('2026-10-01'), status: 'draft' },
      { name: 'Not published', eventDate: new Date('2026-10-01'), status: 'pools_ready' },
      { name: 'Open night', eventDate: new Date('2026-09-19'), status: 'underway', bracketMode: 'native' },
      { name: 'Completed night', eventDate: new Date('2026-09-20'), status: 'complete' },
    ]).returning();
    await db.insert(eventOperationSettings).values(plans.slice(1).map((plan, index) => ({ eventPlanId: plan.id, published: index > 0 })));
    const list = await publicEventNights(db);
    expect(list.map(event => event.name)).toEqual(['Open night', 'Completed night']);
    expect(Object.keys(list[0]!).sort()).toEqual(['bracketMode', 'eventDate', 'id', 'name', 'status']);
    await db.update(eventOperationSettings).set({ published: false }).where(eq(eventOperationSettings.eventPlanId, plans[2]!.id));
    expect((await publicEventNights(db)).map(event => event.name)).toEqual(['Completed night']);
  } finally { await close(); }
});
