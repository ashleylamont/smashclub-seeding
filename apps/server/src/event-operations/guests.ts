import { canAutoAcceptPoolScore } from './selfService';
import { loadStationQueues } from './queue';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventGuestRateLimits, eventGuestSessions, eventGuestSettings, eventMatches, eventOperationSettings, eventScoreReports, eventWithdrawals, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';
import { lockEvent, requireOperator, snapshot, validateScore, applyScore } from './service';

// Rotate the displayed code every 15 minutes, but keep every issued code valid
// for at least a full hour. A photo of the previous code remains usable.
const INVITATION_ROTATION_MS = 15 * 60_000;
const INVITATION_MS = 75 * 60_000;
const SESSION_MS = 60 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const deny = () => { throw new TRPCError({ code: 'FORBIDDEN', message: 'Guest access expired or is unavailable. Scan the current event QR code.' }); };
const limited = () => { throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many guest requests. Please wait before trying again or ask an organiser.' }); };
const publicSettings = (s?: typeof eventGuestSettings.$inferSelect) => ({ enabled: s?.enabled ?? false, showOnOverlay: s?.showOnOverlay ?? false });

export async function guestSettings(db: Db, actor: SessionUser, planId: string) {
    await requireOperator(db, planId, actor);
    return publicSettings((await db.select().from(eventGuestSettings).where(eq(eventGuestSettings.eventPlanId, planId)))[0]);
}
export async function configureGuests(db: Db, actor: SessionUser, input: { planId: string; enabled: boolean; showOnOverlay: boolean }, rotate = false) {
    return db.transaction(async tx => {
        await lockEvent(tx, input.planId);
        await requireOperator(tx, input.planId, actor);
        const [previous] = await tx.select().from(eventGuestSettings).where(eq(eventGuestSettings.eventPlanId, input.planId));
        const secret = !previous || rotate || !input.enabled || !previous.enabled ? randomToken() : previous.secret;
        const [settings] = await tx.insert(eventGuestSettings).values({ eventPlanId: input.planId, enabled: input.enabled, showOnOverlay: input.showOnOverlay, secret }).onConflictDoUpdate({ target: eventGuestSettings.eventPlanId, set: { enabled: input.enabled, showOnOverlay: input.showOnOverlay, secret } }).returning();
        return publicSettings(settings);
    });
}
export async function rotateGuests(db: Db, actor: SessionUser, planId: string) {
    return db.transaction(async tx => {
        await lockEvent(tx, planId);
        await requireOperator(tx, planId, actor);
        const [settings] = await tx.update(eventGuestSettings).set({ secret: randomToken() }).where(eq(eventGuestSettings.eventPlanId, planId)).returning();
        return publicSettings(settings);
    });
}
async function available(db: Db, planId: string) {
    await lockEvent(db, planId);
    const [settings] = await db.select().from(eventGuestSettings).where(eq(eventGuestSettings.eventPlanId, planId));
    const [ops] = await db.select().from(eventOperationSettings).where(eq(eventOperationSettings.eventPlanId, planId));
    if (!settings?.enabled || !ops?.published) return deny();
    return settings;
}
function invitation(settings: typeof eventGuestSettings.$inferSelect, now: number) {
    const expires = Math.floor(now / INVITATION_ROTATION_MS) * INVITATION_ROTATION_MS + INVITATION_MS;
    const signature = createHmac('sha256', settings.secret).update(`${settings.eventPlanId}:${expires}`).digest('base64url');
    return { token: `${expires}.${signature}`, expiresAt: new Date(expires).toISOString() };
}
export async function guestInvitation(db: Db, planId: string, actor?: SessionUser, now = Date.now()) {
    return db.transaction(async tx => {
        if (actor) await requireOperator(tx, planId, actor);
        try {
            const settings = await available(tx, planId);
            if (!actor && !settings.showOnOverlay) return null;
            return invitation(settings, now);
        } catch (error) {
            if (!actor && error instanceof TRPCError && ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT'].includes(error.code)) return null;
            throw error;
        }
    });
}
/** Committed separately so invalid redemption attempts also consume their allowance. */
async function consumeRedemptionLimit(db: Db, planId: string, ip: string, now: number) {
    const accepted = await db.transaction(async tx => {
        const settings = await available(tx, planId);
        await tx.delete(eventGuestRateLimits).where(and(eq(eventGuestRateLimits.eventPlanId, planId), lt(eventGuestRateLimits.expiresAt, new Date(now))));
        const window = Math.floor(now / SESSION_MS);
        const scopes = [{ key: hash(`${settings.secret}:${ip}:${window}`), max: 240 }, { key: hash(`${settings.secret}:event:${window}`), max: 1500 }];
        for (const scope of scopes) {
            const [row] = await tx.select().from(eventGuestRateLimits).where(eq(eventGuestRateLimits.key, scope.key));
            if (row && row.count >= scope.max) return false;
        }
        for (const scope of scopes) await tx.insert(eventGuestRateLimits).values({ key: scope.key, eventPlanId: planId, count: 1, expiresAt: new Date((window + 1) * SESSION_MS) }).onConflictDoUpdate({ target: eventGuestRateLimits.key, set: { count: sql`${eventGuestRateLimits.count} + 1` } });
        return true;
    });
    if (!accepted) limited();
}
export async function redeemGuest(db: Db, input: { planId: string; token: string }, ip = 'unknown', now = Date.now()) {
    await consumeRedemptionLimit(db, input.planId, ip, now);
    return db.transaction(async tx => {
        const settings = await available(tx, input.planId);
        const expires = Number(input.token.split('.')[0]);
        if (!Number.isSafeInteger(expires) || expires <= now || expires > now + INVITATION_MS) return deny();
        const signature = createHmac('sha256', settings.secret).update(`${settings.eventPlanId}:${expires}`).digest('base64url');
        const expected = `${expires}.${signature}`;
        const supplied = Buffer.from(input.token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, Buffer.from(expected))) return deny();
        const sessionToken = randomToken();
        const expiresAt = new Date(now + SESSION_MS);
        await tx.insert(eventGuestSessions).values({ eventPlanId: input.planId, tokenHash: hash(sessionToken), generation: hash(settings.secret), expiresAt });
        return { sessionToken, expiresAt: expiresAt.toISOString() };
    });
}
export async function validateGuestSession(db: Db, input: { planId: string; sessionToken: string }, now: number) {
    const settings = await available(db, input.planId);
    const [guest] = await db.select().from(eventGuestSessions).where(and(eq(eventGuestSessions.eventPlanId, input.planId), eq(eventGuestSessions.tokenHash, hash(input.sessionToken))));
    if (!guest || guest.expiresAt.getTime() <= now || guest.generation !== hash(settings.secret)) return deny();
    return guest;
}
export async function guestMatches(db: Db, input: { planId: string; sessionToken: string }, now = Date.now()) {
    return db.transaction(async tx => {
        const guest = await validateGuestSession(tx, input, now);
        const data = await snapshot(tx, input.planId);
        const reports = await tx.select({ id: eventScoreReports.id, matchId: eventScoreReports.matchId, status: eventScoreReports.status, score1: eventScoreReports.score1, score2: eventScoreReports.score2 }).from(eventScoreReports).where(eq(eventScoreReports.guestSessionId, guest.id)).orderBy(desc(eventScoreReports.createdAt), desc(eventScoreReports.id));
        return { plan: data.plan, stations: data.stations, poolSchedules: data.poolSchedules, ...await loadStationQueues(tx, input.planId), matches: data.matches, reports, expiresAt: guest.expiresAt.toISOString() };
    });
}
export async function submitGuest(db: Db, input: { planId: string; sessionToken: string; matchId: string; expectedRevision: number; requestId: string; score1: number; score2: number }, now = Date.now()) {
    return db.transaction(async tx => {
        const guest = await validateGuestSession(tx, input, now);
        const reports = await tx.select().from(eventScoreReports).where(eq(eventScoreReports.guestSessionId, guest.id));
        const prior = reports.find(r => r.requestId === input.requestId);
        if (prior) {
            if (prior.matchId !== input.matchId || prior.expectedRevision !== input.expectedRevision || prior.score1 !== input.score1 || prior.score2 !== input.score2) throw new TRPCError({ code: 'CONFLICT', message: 'Request identifier already used for a different score.' });
            return { reportId: prior.id, status: prior.status };
        }
        const [match] = await tx.select().from(eventMatches).where(and(eq(eventMatches.id, input.matchId), eq(eventMatches.eventPlanId, input.planId)));
        if (!match || !['ready', 'playing'].includes(match.status) || match.revision !== input.expectedRevision) throw new TRPCError({ code: 'CONFLICT', message: 'This match changed or is unavailable. Refresh the match list.' });
        const withdrawn = await tx.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, input.planId));
        if (withdrawn.some(w => [match.player1Id, match.player2Id].includes(w.playerId))) throw new TRPCError({ code: 'CONFLICT', message: 'A player withdrew. Ask an organiser to record this match.' });
        const winnerId = validateScore(match, { ...input, outcome: 'played' });
        if (reports.some(r => r.matchId === match.id && r.status === 'pending')) throw new TRPCError({ code: 'CONFLICT', message: 'Your score is already waiting for organiser approval.' });
        const [eventCount] = await tx.select({ count: sql<number>`count(*)::integer` }).from(eventScoreReports).where(and(eq(eventScoreReports.eventPlanId, input.planId), eq(eventScoreReports.status, 'pending')));
        // Durable caps remain in force across processes and restarts. Valid retries cost nothing.
        if (reports.length >= 30 || reports.filter(r => r.createdAt.getTime() > now - 60_000).length >= 6 || (eventCount?.count ?? 0) >= 200) limited();
        const accepted = await canAutoAcceptPoolScore(tx, match);
        if (accepted) await applyScore(tx, match, { ...input, outcome: 'played' }, winnerId, null, guest.id);
        const [report] = await tx.insert(eventScoreReports).values({ eventPlanId: input.planId, guestSessionId: guest.id, matchId: match.id, expectedRevision: input.expectedRevision, requestId: input.requestId, score1: input.score1, score2: input.score2, outcome: 'played', winnerId, status: accepted ? 'approved' : 'pending' }).returning();
        return { reportId: report!.id, status: report!.status };
    });
}
