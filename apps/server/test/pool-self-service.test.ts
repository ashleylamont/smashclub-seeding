import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches, eventMatchAudit, eventOperationSettings, eventPlanEntries, eventPlans, eventPoolSchedules, eventStations, players, user, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { prepare, reportScore } from '../src/event-operations/service';
import { startPoolMatch } from '../src/event-operations/selfService';
import { loadStationQueues } from '../src/event-operations/queue';
import { configureGuests, guestInvitation, redeemGuest, rotateGuests, submitGuest } from '../src/event-operations/guests';
import type { SessionUser } from '../src/auth';
let db: Db, close: () => Promise<void>, planId: string, stationId: string;
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const member: SessionUser = { id: 'member', role: 'user', name: 'Attendee', email: 'member@example.test' };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values([admin, member]);
  const ids = (await db.insert(players).values(Array.from({ length: 8 }, (_, i) => ({ canonicalName: `Entrant ${i}` }))).returning()).map(p => p.id);
  planId = (await db.insert(eventPlans).values({ name: 'Native pools', eventDate: new Date(), status: 'pools_ready', bracketMode: 'native' }).returning())[0]!.id;
  await db.insert(eventPlanEntries).values(ids.map((playerId, i) => ({ eventPlanId: planId, playerId, sourceLineNumber: i + 1, rawInput: 'Entrant', cleanedName: 'Entrant', assignedDivision: i < 4 ? 'upper' as const : 'lower' as const, divisionSeed: i % 4 + 1 })));
  await prepare(db, planId);
  await db.update(eventOperationSettings).set({ published: true, playerReports: true }).where(eq(eventOperationSettings.eventPlanId, planId));
  stationId = (await db.insert(eventStations).values({ eventPlanId: planId, name: 'Setup 1' }).returning())[0]!.id;
  await db.insert(eventPoolSchedules).values({ eventPlanId: planId, division: 'upper', poolIndex: 0, stationIds: [stationId], selfRun: true, autoAcceptScores: true });
});
afterEach(async () => close());
async function next() {
  const queue = (await loadStationQueues(db, planId)).stationQueues.find(q => q.stationId === stationId)!;
  expect(queue.nextMatchId).toBeTruthy();
  return (await db.select().from(eventMatches).where(eq(eventMatches.id, queue.nextMatchId!)))[0]!;
}
const start = (m: typeof eventMatches.$inferSelect) => ({ planId, stationId, matchId: m.id, expectedRevision: m.revision });
const score = (m: typeof eventMatches.$inferSelect, requestId = 'score') => ({ matchId: m.id, expectedRevision: m.revision, requestId, score1: 2, score2: 1, outcome: 'played' as const });
async function guest() {
  await configureGuests(db, admin, { planId, enabled: true, showOnOverlay: false });
  const invite = (await guestInvitation(db, planId, admin))!;
  return redeemGuest(db, { planId, token: invite.token });
}
it('starts only the queued match and auto-accepts once with real attendee attribution', async () => {
  const m = await next();
  const another = (await db.select().from(eventMatches)).find(row => row.id !== m.id)!;
  await expect(startPoolMatch(db, member, start(another))).rejects.toMatchObject({ code: 'CONFLICT' });
  const playing = await startPoolMatch(db, member, start(m));
  await expect(startPoolMatch(db, member, start(m))).rejects.toMatchObject({ code: 'CONFLICT' });
  const result = await reportScore(db, member, score(playing));
  expect(result.status).toBe('approved');
  expect(await reportScore(db, member, score(playing))).toEqual(result);
  await expect(reportScore(db, member, score(playing, 'competing-result'))).rejects.toMatchObject({ code: 'CONFLICT' });
  const audits = await db.select().from(eventMatchAudit);
  expect(audits).toHaveLength(2);
  expect(audits.every(a => a.userId === member.id && a.guestSessionId === null)).toBe(true);
  expect((await next()).id).not.toBe(m.id);
});
it('guest start and automatic score retain guest identity, and revoked credentials cannot write', async () => {
  const { sessionToken } = await guest();
  const playing = await startPoolMatch(db, null, { ...start(await next()), sessionToken });
  const input = { ...score(playing), planId, sessionToken };
  expect((await submitGuest(db, input)).status).toBe('approved');
  expect((await submitGuest(db, input)).status).toBe('approved');
  const audits = await db.select().from(eventMatchAudit);
  expect(audits).toHaveLength(2);
  expect(audits.every(a => a.userId === null && !!a.guestSessionId)).toBe(true);
  await rotateGuests(db, admin, planId);
  await expect(startPoolMatch(db, null, { ...start(await next()), sessionToken })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(submitGuest(db, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('requires opt-in and attendee publication permissions; disabled autoaccept retains review', async () => {
  const m = await next();
  await db.update(eventOperationSettings).set({ playerReports: false }).where(eq(eventOperationSettings.eventPlanId, planId));
  await expect(startPoolMatch(db, member, start(m))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await db.update(eventOperationSettings).set({ playerReports: true }).where(eq(eventOperationSettings.eventPlanId, planId));
  await db.update(eventPoolSchedules).set({ selfRun: false }).where(eq(eventPoolSchedules.eventPlanId, planId));
  await expect(startPoolMatch(db, member, start(m))).rejects.toMatchObject({ code: 'CONFLICT' });
  await db.update(eventPoolSchedules).set({ selfRun: true, autoAcceptScores: false }).where(eq(eventPoolSchedules.eventPlanId, planId));
  const playing = await startPoolMatch(db, member, start(m));
  expect((await reportScore(db, member, score(playing))).status).toBe('pending');
  expect((await db.select().from(eventMatches).where(eq(eventMatches.id, m.id)))[0]!.status).toBe('playing');
  await expect(reportScore(db, member, { ...score(playing, 'forfeit'), outcome: 'forfeit' })).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('guest reports without opt-in remain pending and closing the event prevents starts', async () => {
  const { sessionToken } = await guest();
  await db.update(eventPoolSchedules).set({ autoAcceptScores: false }).where(eq(eventPoolSchedules.eventPlanId, planId));
  const playing = await startPoolMatch(db, null, { ...start(await next()), sessionToken });
  expect((await submitGuest(db, { ...score(playing), planId, sessionToken })).status).toBe('pending');
  await db.update(eventPlans).set({ status: 'cancelled' }).where(eq(eventPlans.id, planId));
  await expect(startPoolMatch(db, member, start(playing))).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('rejects expired guests and never auto-accepts an unstarted match', async () => {
  const { sessionToken, expiresAt } = await guest();
  const m = await next();
  await expect(startPoolMatch(db, null, { ...start(m), sessionToken }, Date.parse(expiresAt))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect((await reportScore(db, member, score(m))).status).toBe('pending');
});

it('allows only one stale competing start and one competing automatic result', async () => {
  const other: SessionUser = { id: 'other', role: 'user', name: 'Other attendee', email: 'other@example.test' };
  await db.insert(user).values(other);
  const m = await next();
  // PGlite serialises transactions; these cover the losing client's stale revision.
  const attempts = await Promise.allSettled([startPoolMatch(db, member, start(m)), startPoolMatch(db, other, start(m))]);
  expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
  const playing = (await db.select().from(eventMatches).where(eq(eventMatches.id, m.id)))[0]!;
  const results = await Promise.allSettled([reportScore(db, member, score(playing, 'first')), reportScore(db, other, { ...score(playing, 'second'), score1: 1, score2: 2 })]);
  expect(results.filter(a => a.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(a => a.status === 'rejected')).toHaveLength(1);
  expect(await db.select().from(eventMatchAudit)).toHaveLength(2);
});
