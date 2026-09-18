import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventGuestRateLimits, eventGuestSessions, eventGuestSettings, eventMatchAudit, eventMatches, eventOperationSettings, eventPlanEntries, eventPlans, eventScoreReports, players, user, type Db } from '@smashclub/db';
import { configureGuests, guestInvitation, guestMatches, redeemGuest, submitGuest } from '../src/event-operations/guests';
import { prepare, reportScore, reviewReport, snapshot } from '../src/event-operations/service';
import { createTestDb } from './helpers/testDb';
import type { SessionUser } from '../src/auth';
let db: Db;
let close: () => Promise<void>;
let planId: string;
let match: typeof eventMatches.$inferSelect;
let now: number;
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const member: SessionUser = { id: 'member', role: 'user', name: 'Unlinked', email: 'player@example.test' };
beforeEach(async () => {
    ({ db, close } = await createTestDb());
    now = Date.now();
    await db.insert(user).values([admin, member]);
    const ids = (await db.insert(players).values(Array.from({ length: 8 }, (_, i) => ({ canonicalName: `Private ${i}`, displayName: `Alias${i}` }))).returning()).map(p => p.id);
    planId = (await db.insert(eventPlans).values({ name: 'Rehearsal', eventDate: new Date(), status: 'pools_ready' }).returning())[0]!.id;
    await db.insert(eventPlanEntries).values(ids.map((id, i) => ({ eventPlanId: planId, sourceLineNumber: i + 1, rawInput: 'Private', cleanedName: 'Private', playerId: id, assignedDivision: i < 4 ? 'upper' as const : 'lower' as const, divisionSeed: i % 4 + 1 })));
    await prepare(db, planId);
    match = (await db.select().from(eventMatches))[0]!;
    await db.update(eventOperationSettings).set({ published: true }).where(eq(eventOperationSettings.eventPlanId, planId));
});
afterEach(async () => close());
async function enable(showOnOverlay = false) { await configureGuests(db, admin, { planId, enabled: true, showOnOverlay }); }
async function join() {
    const invite = await guestInvitation(db, planId, admin, now);
    return redeemGuest(db, { planId, token: invite!.token }, 'test-ip', now);
}
const input = (sessionToken: string, requestId = 'guest-score') => ({ planId, sessionToken, matchId: match.id, expectedRevision: match.revision, requestId, score1: 2, score2: 1 });
describe('guest reporting', () => {
    it('keeps a QR link usable for at least an hour across displayed code rotations', async () => {
        await enable();
        const issuedAt = Math.floor(now / 900_000) * 900_000 + 899_999;
        const invite = (await guestInvitation(db, planId, admin, issuedAt))!;
        expect(Date.parse(invite.expiresAt) - issuedAt).toBeGreaterThanOrEqual(60 * 60_000);
        const next = (await guestInvitation(db, planId, admin, issuedAt + 15 * 60_000))!;
        expect(next.token).not.toBe(invite.token);
        const guest = await redeemGuest(db, { planId, token: invite.token }, 'later-guest', issuedAt + 60 * 60_000);
        expect(Date.parse(guest.expiresAt)).toBe(issuedAt + 120 * 60_000);
    });
    it('is opt-in and keeps overlay sharing separate, with no secrets in snapshot', async () => {
        expect(await guestInvitation(db, planId)).toBeNull();
        await expect(guestInvitation(db, planId, admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(configureGuests(db, member, { planId, enabled: true, showOnOverlay: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await enable();
        expect(await guestInvitation(db, planId)).toBeNull();
        await enable(true);
        expect(await guestInvitation(db, planId, undefined, now)).toEqual(await guestInvitation(db, planId, admin, now));
        const [settings] = await db.select().from(eventGuestSettings);
        const publicData = JSON.stringify(await snapshot(db, planId));
        expect(publicData).not.toContain(settings!.secret);
        expect(publicData).not.toContain('Private');
    });
    it('lets a bearer report without an account, stores only a token hash, and waits for approval', async () => {
        await enable();
        const guest = await join();
        expect(JSON.stringify(await db.select().from(eventGuestSessions))).not.toContain(guest.sessionToken);
        const report = await submitGuest(db, input(guest.sessionToken), now);
        const [saved] = await db.select().from(eventScoreReports);
        expect(saved).toMatchObject({ userId: null, status: 'pending' });
        expect(saved!.guestSessionId).toBeTruthy();
        expect(await db.select().from(eventMatchAudit)).toHaveLength(0);
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, match.id)))[0]!.resultUpdatedAt).toBeNull();
        expect((await guestMatches(db, { planId, sessionToken: guest.sessionToken }, now)).reports).toHaveLength(1);
        await reviewReport(db, admin, report.reportId, true);
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, match.id)))[0]).toMatchObject({ score1: 2, score2: 1, status: 'complete' });
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, match.id)))[0]!.resultUpdatedAt).toBeInstanceOf(Date);
        expect((await submitGuest(db, input(guest.sessionToken), now)).status).toBe('approved');
    });
    it('keeps guest reports private to their session, prevents duplicate pending and request reuse', async () => {
        await enable();
        const a = await join(), b = await join();
        const report = await submitGuest(db, input(a.sessionToken), now);
        expect(await submitGuest(db, input(a.sessionToken), now)).toEqual(report);
        expect((await guestMatches(db, { planId, sessionToken: b.sessionToken }, now)).reports).toEqual([]);
        await expect(submitGuest(db, { ...input(a.sessionToken), score2: 0 }, now)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(submitGuest(db, input(a.sessionToken, 'duplicate'), now)).rejects.toMatchObject({ code: 'CONFLICT' });
        await reviewReport(db, admin, report.reportId, false);
        const retry = await submitGuest(db, input(a.sessionToken, 'new-attempt'), now);
        expect(retry.status).toBe('pending');
        expect((await guestMatches(db, { planId, sessionToken: a.sessionToken }, now)).reports[0]!.id).toBe(retry.reportId);
    });
    it('rejects expired, tampered and other-event invitations and sessions', async () => {
        await enable();
        const invite = (await guestInvitation(db, planId, admin, now))!;
        const guest = await join();
        await expect(redeemGuest(db, { planId, token: `${invite.token}x` }, 'test', now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(redeemGuest(db, { planId, token: invite.token }, 'test', Date.parse(invite.expiresAt))).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(guestMatches(db, { planId, sessionToken: guest.sessionToken }, Date.parse(guest.expiresAt))).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const [other] = await db.insert(eventPlans).values({ name: 'Other', eventDate: new Date(), status: 'pools_ready' }).returning();
        await db.insert(eventOperationSettings).values({ eventPlanId: other!.id, published: true });
        await configureGuests(db, admin, { planId: other!.id, enabled: true, showOnOverlay: false });
        await expect(redeemGuest(db, { planId: other!.id, token: invite.token }, 'test', now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(guestMatches(db, { planId: other!.id, sessionToken: guest.sessionToken }, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
    it('disabling, rotating, unpublishing or closing revokes access immediately', async () => {
        await enable();
        const invite = (await guestInvitation(db, planId, admin, now))!;
        const guest = await join();
        await configureGuests(db, admin, { planId, enabled: true, showOnOverlay: false }, true);
        await expect(guestMatches(db, { planId, sessionToken: guest.sessionToken }, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(redeemGuest(db, { planId, token: invite.token }, 'test', now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const second = await join();
        await configureGuests(db, admin, { planId, enabled: false, showOnOverlay: false });
        await enable();
        await expect(guestMatches(db, { planId, sessionToken: second.sessionToken }, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const third = await join();
        await db.update(eventOperationSettings).set({ published: false }).where(eq(eventOperationSettings.eventPlanId, planId));
        await expect(submitGuest(db, input(third.sessionToken), now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await db.update(eventOperationSettings).set({ published: true }).where(eq(eventOperationSettings.eventPlanId, planId));
        await db.update(eventPlans).set({ status: 'complete' }).where(eq(eventPlans.id, planId));
        expect(await guestInvitation(db, planId)).toBeNull();
        await expect(submitGuest(db, input(third.sessionToken), now)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    it('rejects blocked/completed/stale matches, invalid scores, and stale TO approval', async () => {
        await enable();
        const guest = await join();
        await expect(submitGuest(db, { ...input(guest.sessionToken), score1: 1 }, now)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(submitGuest(db, { ...input(guest.sessionToken), score1: 99 }, now)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await db.update(eventMatches).set({ status: 'blocked' }).where(eq(eventMatches.id, match.id));
        await expect(submitGuest(db, input(guest.sessionToken), now)).rejects.toMatchObject({ code: 'CONFLICT' });
        await db.update(eventMatches).set({ status: 'ready' }).where(eq(eventMatches.id, match.id));
        const pending = await submitGuest(db, input(guest.sessionToken), now);
        await reportScore(db, admin, { ...input(guest.sessionToken), requestId: 'to', outcome: 'played' });
        await expect(reviewReport(db, admin, pending.reportId, true)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(submitGuest(db, input(guest.sessionToken, 'completed'), now)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    it('persists redemption throttling including invalid tokens, without storing raw IP addresses', async () => {
        await enable();
        await expect(redeemGuest(db, { planId, token: 'wrong' }, '192.0.2.7', now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const limits = await db.select().from(eventGuestRateLimits);
        expect(limits.map(x => x.count)).toEqual([1, 1]);
        expect(JSON.stringify(limits)).not.toContain('192.0.2.7');
        await db.update(eventGuestRateLimits).set({ count: 1500 });
        const invitation = (await guestInvitation(db, planId, admin, now))!;
        await expect(redeemGuest(db, { planId, token: invitation.token }, '192.0.2.7', now)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    });
    it('limits submission bursts durably but still accepts idempotent retries', async () => {
        await enable();
        const guest = await join();
        const matches = await db.select().from(eventMatches);
        let first: Awaited<ReturnType<typeof submitGuest>> | undefined;
        for (const [i, m] of matches.slice(0, 6).entries()) {
            const result = await submitGuest(db, { ...input(guest.sessionToken, `r${i}`), matchId: m.id }, now);
            first ??= result;
        }
        expect(await submitGuest(db, { ...input(guest.sessionToken, 'r0'), matchId: matches[0]!.id }, now)).toEqual(first);
        await expect(submitGuest(db, { ...input(guest.sessionToken, 'r6'), matchId: matches[6]!.id }, now)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    });
});
