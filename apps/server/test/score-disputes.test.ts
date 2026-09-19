import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches, eventMatchAudit, eventOperationSettings, eventPlanEntries, eventPlans, eventScoreReports, eventWithdrawals, players, user, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { prepare, reportScore, reviewReport, snapshot, updateMatch } from '../src/event-operations/service';
import { configureGuests, guestInvitation, redeemGuest, rotateGuests, submitGuest } from '../src/event-operations/guests';
import type { SessionUser } from '../src/auth';
let db: Db, close: () => Promise<void>, planId: string;
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const member: SessionUser = { id: 'member', role: 'user', name: 'Unlinked attendee', email: 'member@example.test' };
const other: SessionUser = { id: 'other', role: 'user', name: 'Other attendee', email: 'other@example.test' };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values([admin, member, other]);
  const ids = (await db.insert(players).values(Array.from({ length: 8 }, (_, i) => ({ canonicalName: `Entrant ${i}` }))).returning()).map(p => p.id);
  planId = (await db.insert(eventPlans).values({ name: 'Native pools', eventDate: new Date(), status: 'pools_ready', bracketMode: 'native' }).returning())[0]!.id;
  await db.insert(eventPlanEntries).values(ids.map((playerId, i) => ({ eventPlanId: planId, playerId, sourceLineNumber: i + 1, rawInput: 'Entrant', cleanedName: 'Entrant', assignedDivision: i < 4 ? 'upper' as const : 'lower' as const, divisionSeed: i % 4 + 1 })));
  await prepare(db, planId);
  await db.update(eventOperationSettings).set({ published: true, playerReports: true, scoreReportingMode: 'approve_unless_disputed' }).where(eq(eventOperationSettings.eventPlanId, planId));
});
afterEach(async () => close());
async function match(id?: string) { return id ? (await db.select().from(eventMatches).where(eq(eventMatches.id, id)))[0]! : (await db.select().from(eventMatches))[0]!; }
const score = (m: typeof eventMatches.$inferSelect, requestId: string = crypto.randomUUID()) => ({ matchId: m.id, expectedRevision: m.revision, requestId, score1: 2, score2: 1, outcome: 'played' as const });
async function guest() {
  await configureGuests(db, admin, { planId, enabled: true, showOnOverlay: false });
  return redeemGuest(db, { planId, token: (await guestInvitation(db, planId, admin))!.token });
}
it('immediately advances the first unlinked attendee report, corroborates once, flags conflicts without overwriting', async () => {
  const initial = await match();
  const first = await reportScore(db, member, score(initial, 'first'));
  expect(first).toMatchObject({ status: 'approved', autoApproved: true, isDispute: false, submittedRevision: initial.revision });
  const complete = await match(initial.id);
  expect(complete).toMatchObject({ status: 'complete', revision: initial.revision + 1 });
  const confirmation = await reportScore(db, other, score(complete));
  expect(confirmation).toMatchObject({ status: 'approved', autoApproved: false, isDispute: false });
  const input = { ...score(initial, 'conflict'), score1: 1, score2: 2 };
  const dispute = await reportScore(db, other, input);
  expect(dispute).toMatchObject({ status: 'pending', isDispute: true, expectedRevision: complete.revision, submittedRevision: initial.revision });
  expect(await reportScore(db, other, input)).toEqual(dispute);
  await expect(reportScore(db, other, { ...input, score1: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await match(initial.id)).toEqual(complete);
  expect(await db.select().from(eventMatchAudit)).toHaveLength(1);
  const publicMatch = (await snapshot(db, planId)).matches.find(m => m.id === initial.id)!;
  expect(publicMatch.pendingDisputeCount).toBe(1);
  expect((await reviewReport(db, admin, dispute.id, false)).status).toBe('rejected');
  expect((await snapshot(db, planId)).matches.find(m => m.id === initial.id)!.pendingDisputeCount).toBe(0);
});
it('TO can approve a differing score and ordinary stale forms cannot survive the correction', async () => {
  const initial = await match();
  await reportScore(db, member, score(initial));
  const dispute = await reportScore(db, other, { ...score(initial), score1: 0, score2: 2 });
  await reviewReport(db, admin, dispute.id, true);
  expect(await match(initial.id)).toMatchObject({ score1: 0, score2: 2, winnerId: initial.player2Id, revision: initial.revision + 2 });
  await expect(reportScore(db, member, score(initial))).rejects.toMatchObject({ code: 'CONFLICT' });
  // One behind a TO correction is also stale, even though it's just one revision.
  await expect(reportScore(db, member, { ...score(initial), expectedRevision: initial.revision + 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
  const current = await match(initial.id);
  expect((await reportScore(db, member, { ...score(current), score1: 0, score2: 2 })).status).toBe('approved');
});
it('same winner but different game counts is a dispute, not an agreement', async () => {
  const initial = await match();
  await reportScore(db, member, score(initial));
  const dispute = await reportScore(db, other, { ...score(initial), score2: 0 });
  expect(dispute).toMatchObject({ status: 'pending', isDispute: true });
  expect(await match(initial.id)).toMatchObject({ score1: 2, score2: 1 });
});
it('guest and signed-in competing reports serialize, with one result and one reviewable dispute', async () => {
  const { sessionToken } = await guest();
  const initial = await match();
  const guestInput = { ...score(initial), planId, sessionToken, score1: 0, score2: 2 };
  const results = await Promise.all([reportScore(db, member, score(initial)), submitGuest(db, guestInput)]);
  expect(results.map(r => r.status).sort()).toEqual(['approved', 'pending']);
  expect(await db.select().from(eventMatchAudit)).toHaveLength(1);
  const repeated = await submitGuest(db, guestInput);
  expect(repeated.status).toBe(results[1].status);
  const rows = await db.select().from(eventScoreReports);
  expect(rows).toHaveLength(2);
  expect(rows.find(r => r.guestSessionId)).toBeTruthy();
});
it('guest first result, identical stale confirmation and later current dispute preserve guest attribution', async () => {
  const { sessionToken } = await guest();
  const initial = await match();
  expect((await submitGuest(db, { ...score(initial), planId, sessionToken })).status).toBe('approved');
  expect((await reportScore(db, member, score(initial))).status).toBe('approved');
  const current = await match(initial.id);
  const input = { ...score(current), planId, sessionToken, score1: 1, score2: 2 };
  const result = await submitGuest(db, input);
  expect(result).toMatchObject({ status: 'pending', isDispute: true });
  expect(await submitGuest(db, input)).toEqual(result);
  const audits = await db.select().from(eventMatchAudit);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ userId: null });
  expect(audits[0]!.guestSessionId).toBeTruthy();
  await rotateGuests(db, admin, planId);
  await expect(submitGuest(db, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('manual policy and imported brackets preserve approval and correction restrictions', async () => {
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'to_review' });
  const initial = await match();
  const pending = await reportScore(db, member, score(initial));
  expect(pending.status).toBe('pending');
  await reviewReport(db, admin, pending.id, true);
  await expect(reportScore(db, other, score(await match(initial.id)))).rejects.toMatchObject({ code: 'CONFLICT' });
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'approve_unless_disputed' });
  await db.update(eventPlans).set({ bracketMode: 'challonge' });
  const next = (await db.select().from(eventMatches)).find(m => m.status === 'ready')!;
  expect((await reportScore(db, other, score(next))).status).toBe('pending');
});
it('changing policy cannot silently choose a winner over an existing pending conflict', async () => {
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'to_review' });
  const initial = await match();
  const pending = await reportScore(db, member, score(initial));
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'approve_unless_disputed' });
  const conflict = await reportScore(db, other, { ...score(initial), score1: 0, score2: 2 });
  expect(conflict).toMatchObject({ status: 'pending', isDispute: true });
  expect(await match(initial.id)).toMatchObject({ status: 'ready', revision: initial.revision });
  expect((await db.select().from(eventScoreReports).where(eq(eventScoreReports.id, pending.id)))[0]!.isDispute).toBe(true);
});
it('rejects non-result stale revisions, disabled access, withdrawn entrants, and post-close reports', async () => {
  const { sessionToken } = await guest();
  const initial = await match();
  await updateMatch(db, admin, { matchId: initial.id, expectedRevision: initial.revision, status: 'playing' });
  await expect(reportScore(db, member, score(initial))).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(submitGuest(db, { ...score(initial), planId, sessionToken })).rejects.toMatchObject({ code: 'CONFLICT' });
  const current = await match(initial.id);
  await db.update(eventOperationSettings).set({ playerReports: false });
  await expect(reportScore(db, member, score(current))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await db.update(eventOperationSettings).set({ playerReports: true });
  await db.insert(eventWithdrawals).values({ eventPlanId: planId, playerId: current.player1Id!, reason: 'Absent' });
  await expect(reportScore(db, member, score(current))).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(submitGuest(db, { ...score(current), planId, sessionToken })).rejects.toMatchObject({ code: 'CONFLICT' });
  await db.update(eventPlans).set({ status: 'complete' });
  await expect(reportScore(db, member, score(current))).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(submitGuest(db, { ...score(current), planId, sessionToken })).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('policy changes approve existing agreeing reports without leaving manual work', async () => {
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'to_review' });
  const initial = await match();
  const pending = await reportScore(db, member, score(initial, 'old-agreement'));
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'approve_unless_disputed' });
  expect((await reportScore(db, other, score(initial))).status).toBe('approved');
  expect((await db.select().from(eventScoreReports).where(eq(eventScoreReports.id, pending.id)))[0]).toMatchObject({ status: 'approved', autoApproved: false });
  expect((await reportScore(db, member, score(initial, 'old-agreement'))).status).toBe('approved');
  expect(await db.select().from(eventMatchAudit)).toHaveLength(1);
});
it('an obsolete pending report cannot veto a current score after an organiser changes the match', async () => {
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'to_review' });
  const initial = await match();
  await reportScore(db, member, score(initial));
  const current = await updateMatch(db, admin, { matchId: initial.id, expectedRevision: initial.revision, status: 'playing' });
  await db.update(eventOperationSettings).set({ scoreReportingMode: 'approve_unless_disputed' });
  const approved = await reportScore(db, other, { ...score(current), score1: 0, score2: 2 });
  expect(approved).toMatchObject({ status: 'approved', isDispute: false });
});
it('expired guest sessions and unpublished events cannot submit or dispute', async () => {
  const { sessionToken, expiresAt } = await guest();
  const initial = await match();
  await reportScore(db, member, score(initial));
  const current = await match(initial.id);
  await expect(submitGuest(db, { ...score(current), planId, sessionToken }, Date.parse(expiresAt))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await db.update(eventOperationSettings).set({ published: false });
  await expect(submitGuest(db, { ...score(current), planId, sessionToken })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(reportScore(db, member, score(current))).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
