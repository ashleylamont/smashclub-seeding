import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  companies,
  eventAttendanceAudit,
  eventOperators,
  eventPlanEntries,
  eventPlans,
  eventWithdrawals,
  players,
  user,
  type Db,
} from '@smashclub/db';
import { attendeeRoster, updateAttendee } from '../src/event-operations/attendeeRoster';
import type { SessionUser } from '../src/auth';
import { createTestDb } from './helpers/testDb';

let db: Db;
let close: () => Promise<void>;
let planId: string;
let ids: string[];
const operator: SessionUser = {
  id: 'operator',
  role: 'user',
  name: 'TO',
  email: 'to@example.test',
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values(operator);
  ids = (
    await db
      .insert(players)
      .values([
        { canonicalName: 'Private Name 0', displayName: 'Alias0' },
        { canonicalName: 'Private Name 1', displayName: 'Alias1' },
        { canonicalName: 'Private Name 2', displayName: 'Alias2' },
      ])
      .returning({ id: players.id })
  ).map((row) => row.id);
  planId = (
    await db
      .insert(eventPlans)
      .values({ name: 'Rehearsal', eventDate: new Date(), status: 'pools_ready' })
      .returning({ id: eventPlans.id })
  )[0]!.id;
  await db.insert(eventPlanEntries).values(
    ids.map((playerId, index) => ({
      eventPlanId: planId,
      sourceLineNumber: index + 1,
      rawInput: index === 0 ? '[Old] Private Name 0' : `Private Name ${index}`,
      cleanedName: `Private Name ${index}`,
      playerId,
      assignedDivision: index === 0 ? ('upper' as const) : ('lower' as const),
    })),
  );
});
afterEach(async () => close());

it('shows current attendee identities only to event organisers and keeps the source roster entry', async () => {
  const [company] = await db
    .insert(companies)
    .values({ code: 'NEW', name: 'New Company' })
    .returning();
  await db.insert(eventWithdrawals).values({
    eventPlanId: planId,
    playerId: ids[1]!,
    reason: 'Left early',
  });
  await expect(attendeeRoster(db, planId, operator)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    updateAttendee(db, operator, {
      planId,
      playerId: ids[0]!,
      canonicalName: 'Unauthorized',
      displayName: null,
      companyCode: null,
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await db.insert(eventOperators).values({ eventPlanId: planId, userId: operator.id });

  const initial = await attendeeRoster(db, planId, operator);
  expect(initial.attendees).toHaveLength(2);
  expect(initial.attendees[0]).toMatchObject({
    rawInput: '[Old] Private Name 0',
    canonicalName: 'Private Name 0',
    publicAlias: 'Alias0',
    division: 'upper',
  });
  expect(initial.attendees.some((row) => row.playerId === ids[1])).toBe(false);
  expect(initial.companies).toContainEqual({ code: 'NEW', name: 'New Company' });

  await updateAttendee(db, operator, {
    planId,
    playerId: ids[0]!,
    canonicalName: 'Correct Name',
    displayName: 'Correct Alias',
    companyCode: company!.code,
  });
  expect((await attendeeRoster(db, planId, operator)).attendees[0]).toMatchObject({
    rawInput: '[Old] Private Name 0',
    canonicalName: 'Correct Name',
    publicAlias: 'Correct Alias',
    companyCode: 'NEW',
  });
  expect(await db.select().from(eventAttendanceAudit)).toMatchObject([
    { eventPlanId: planId, userId: operator.id, action: 'edit_player' },
  ]);
  await expect(
    updateAttendee(db, operator, {
      planId,
      playerId: ids[1]!,
      canonicalName: 'Withdrawn',
      displayName: null,
      companyCode: null,
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    updateAttendee(db, operator, {
      planId,
      playerId: ids[0]!,
      canonicalName: 'Correct Name',
      displayName: 'Alias2',
      companyCode: 'NEW',
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});
