import { expect, it } from 'vitest';
import { eventPlanBrackets, eventPlans, tournaments } from '@smashclub/db';
import { captureBaseline } from '../src/tournament/domain';
import { eventView, planView } from '../src/tournament/views';
import { pureBaseline } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

it('retains native planner lifecycle and publication metadata', async () => {
  const { db, close } = await createTestDb();
  try {
    const baseline = pureBaseline();
    const planId = baseline.planId;
    await db.insert(eventPlans).values({
      id: planId,
      name: baseline.name,
      eventDate: new Date(baseline.eventDate),
      status: 'underway',
      bracketMode: 'native',
    });
    const slots = [
      { division: 'upper', stage: 'main' },
      { division: 'upper', stage: 'consolation' },
      { division: 'lower', stage: 'main' },
      { division: 'lower', stage: 'consolation' },
    ] as const;
    await db.insert(eventPlanBrackets).values(
      slots.map((slot) => ({
        ...slot,
        eventPlanId: planId,
        challongeSlug: `old_${slot.division}_${slot.stage}`,
      })),
    );
    const [upperMain, lowerConsolation] = await db
      .insert(tournaments)
      .values([
        { name: 'Published upper main', challongeSlug: 'planner_upper_main' },
        { name: 'Published lower consolation', challongeSlug: 'planner_lower_consolation' },
        { name: 'Unacknowledged result', challongeSlug: 'planner_upper_consolation' },
      ])
      .returning();
    const acknowledgedSlots = new Map([
      ['upper:main', upperMain],
      ['lower:consolation', lowerConsolation],
    ]);
    const original = captureBaseline(baseline);
    const statuses = [
      ['locked', 'underway'],
      ['unlocked', 'underway'],
      ['finalized', 'complete'],
      ['cancelled', 'cancelled'],
    ] as const;
    for (const [lifecycle, status] of statuses) {
      for (const published of [false, true]) {
        const state = {
          ...original,
          lifecycle,
          publication: published
            ? {
                resultId: crypto.randomUUID(),
                tournamentIds: [upperMain!.id, lowerConsolation!.id, crypto.randomUUID()],
              }
            : null,
        };
        const view = await planView(db, state);
        const publicView = await eventView(db, state);
        const softLockedAt = new Date(baseline.capturedAt).toISOString();
        expect(view.plan).toMatchObject({ status, softLockedAt });
        expect(publicView.plan).toMatchObject({ status, softLockedAt });
        expect(
          view.brackets.map(({ division, stage, tournamentId, challongeSlug }) => ({
            division,
            stage,
            tournamentId,
            challongeSlug,
          })),
        ).toEqual(
          slots.map((slot) => {
            const row = published
              ? acknowledgedSlots.get(`${slot.division}:${slot.stage}`)
              : undefined;
            return {
              ...slot,
              tournamentId: row?.id ?? null,
              challongeSlug: row?.challongeSlug ?? null,
            };
          }),
        );
      }
    }
  } finally {
    await close();
  }
});
