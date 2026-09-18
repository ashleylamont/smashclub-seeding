import { createHash } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventAttendanceAudit, eventMatches, eventPlanBrackets, eventPlanEntries, eventPlanPoolPlacements, eventPoolSchedules, eventPlans, eventPoolAssignments, eventScoreReports, eventWithdrawals, players, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';
import { getPlan } from '../event-planner/plans';
import { lockEvent, prepare, requireOperator } from './service';
export interface AttendanceInput {
    planId: string;
    action: 'add' | 'withdraw';
    playerId: string;
    division?: 'upper' | 'lower';
    poolIndex?: number;
    reason?: string;
    acknowledgeExternalChange?: boolean;
}
export async function previewAttendance(db: Db, input: AttendanceInput) {
    const view = await getPlan(db, input.planId);
    if (!view)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
    const matches = await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, input.planId));
    const withdrawals = await db.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, input.planId));
    const [player] = await db.select().from(players).where(eq(players.id, input.playerId));
    const entrant = view.entries.find(e => e.playerId === input.playerId);
    const division = input.action === 'withdraw' ? entrant?.assignedDivision : input.division;
    const pool = input.action === 'withdraw' ? view.divisions.find(d => d.division === division)?.pools.find(p => p.members.some(m => m.playerId === input.playerId)) : view.divisions.find(d => d.division === division)?.pools.find(p => p.poolIndex === input.poolIndex);
    const issues: string[] = [];
    const warnings: string[] = [];
    if (!['pools_ready', 'underway'].includes(view.plan.status))
        issues.push('Attendance changes require prepared pools in an open event.');
    if (!player || player.status !== 'active')
        issues.push('Choose an existing active player.');
    if (input.action === 'add' && entrant)
        issues.push('This player is already in the event.');
    if (input.action === 'withdraw' && !entrant)
        issues.push('This player is not an event entrant.');
    if (withdrawals.some(w => w.playerId === input.playerId))
        issues.push('This player has already withdrawn.');
    if (!pool)
        issues.push('Choose an existing pool.');
    if (input.action === 'add' && pool && pool.members.length >= 5)
        issues.push('A pool can contain at most five entrants.');
    const attached = view.brackets.filter(b => b.division === division && (b.challongeSlug || b.tournamentId));
    if (input.action === 'add' && (attached.some(b => b.stage === 'consolation') || matches.some(m => m.division === division && m.stage !== 'group' && (m.status === 'playing' || m.status === 'complete'))))
        issues.push('Finals have been handed off or started. Additions require an organiser to reconcile that bracket first.');
    if (attached.length)
        warnings.push('This event has a linked Challonge bracket. Update its roster or withdrawal there manually and sync it; Nemesis does not change the remote bracket.');
    if (input.action === 'withdraw')
        warnings.push('Completed results stay recorded. Outstanding matches are held for explicit forfeit decisions. Reconfirm the pool order afterwards: first two active entrants advance to championship and remaining active entrants enter consolation.');
    if (pool?.members.some(m => m.place !== null))
        warnings.push('Confirmed placements for this pool will be cleared and need reconfirmation.');
    const affected = matches.filter(m => m.player1Id === input.playerId || m.player2Id === input.playerId);
    const revisionToken = createHash('sha256').update(JSON.stringify({ status: view.plan.status, entries: view.entries.map(e => [e.id, e.playerId, e.assignedDivision, e.divisionSeed]), pools: view.divisions.map(d => d.pools.map(p => p.members.map(m => [m.playerId, m.place]))), matches: matches.map(m => [m.id, m.revision, m.status]), brackets: view.brackets.map(b => [b.tournamentId, b.challongeSlug]), withdrawals: withdrawals.map(w => w.playerId) })).digest('hex');
    return { allowed: issues.length === 0, issues, warnings, requiresExternalAcknowledgement: attached.length > 0, division: division ?? null, poolIndex: pool?.poolIndex ?? null, poolSize: pool?.members.length ?? 0, addedMatches: input.action === 'add' ? (pool?.members.length ?? 0) : 0, affectedMatches: affected.map(m => ({ id: m.id, label: m.label, status: m.status })), revisionToken };
}
export async function applyAttendance(db: Db, actor: SessionUser, input: AttendanceInput & {
    revisionToken: string;
}) {
    return db.transaction(async (tx) => {
        await lockEvent(tx, input.planId);
        await requireOperator(tx, input.planId, actor);
        const preview = await previewAttendance(tx, input);
        if (preview.revisionToken !== input.revisionToken)
            throw new TRPCError({ code: 'CONFLICT', message: 'The event changed since this preview. Review the updated attendance change.' });
        if (!preview.allowed)
            throw new TRPCError({ code: 'BAD_REQUEST', message: preview.issues.join(' ') });
        if (preview.requiresExternalAcknowledgement && !input.acknowledgeExternalChange)
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Acknowledge the manual Challonge roster update before applying this change.' });
        const view = (await getPlan(tx, input.planId))!;
        const division = preview.division!;
        const poolIndex = preview.poolIndex!;
        // First change snapshots every current assignment. Subsequent changes extend it.
        const stored = await tx.select().from(eventPoolAssignments).where(eq(eventPoolAssignments.eventPlanId, input.planId));
        if (!stored.length)
            await tx.insert(eventPoolAssignments).values(view.divisions.flatMap(d => d.pools.flatMap(p => p.members.map(m => ({ eventPlanId: input.planId, division: d.division, poolIndex: p.poolIndex, playerId: m.playerId })))));
        if (input.action === 'add') {
            const [player] = await tx.select().from(players).where(eq(players.id, input.playerId));
            const seed = Math.max(0, ...view.entries.filter(e => e.assignedDivision === division).map(e => e.divisionSeed ?? 0)) + 1;
            const line = Math.max(0, ...view.entries.map(e => e.sourceLineNumber)) + 1;
            await tx.insert(eventPlanEntries).values({ eventPlanId: input.planId, playerId: input.playerId, sourceLineNumber: line, rawInput: player!.canonicalName, cleanedName: player!.canonicalName, resolutionMethod: 'manual', divisionPreference: division, assignedDivision: division, divisionSeed: seed });
            await tx.insert(eventPoolAssignments).values({ eventPlanId: input.planId, playerId: input.playerId, division, poolIndex });
            await prepare(tx, input.planId);
        }
        else {
            const reason = input.reason?.trim() || 'Withdrawn from event';
            await tx.insert(eventWithdrawals).values({ eventPlanId: input.planId, playerId: input.playerId, reason });
            const affected = await tx.select().from(eventMatches).where(and(eq(eventMatches.eventPlanId, input.planId), or(eq(eventMatches.player1Id, input.playerId), eq(eventMatches.player2Id, input.playerId))));
            const withdrawnIds=new Set((await tx.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId,input.planId))).map(w=>w.playerId));
            for (const match of affected.filter(m => m.status !== 'complete'))
                await tx.update(eventMatches).set({ status: 'blocked', blockedReason: match.player1Id&&match.player2Id&&withdrawnIds.has(match.player1Id)&&withdrawnIds.has(match.player2Id)?'Both players withdrawn: no contest; no winner or score recorded':'Player withdrawn: awaiting organiser forfeit decision', revision: match.revision + 1 }).where(eq(eventMatches.id, match.id));
        }
        await tx.delete(eventPlanPoolPlacements).where(and(eq(eventPlanPoolPlacements.eventPlanId, input.planId), eq(eventPlanPoolPlacements.division, division), eq(eventPlanPoolPlacements.poolIndex, poolIndex)));
        await tx.insert(eventAttendanceAudit).values({ eventPlanId: input.planId, userId: actor.id, action: input.action, details: { playerId: input.playerId, division, poolIndex, reason: input.reason ?? null, externalAcknowledged: input.acknowledgeExternalChange ?? false, affectedMatches: preview.affectedMatches } });
        await tx.update(eventPlans).set({ updatedAt: new Date() }).where(eq(eventPlans.id, input.planId));
        return { applied: true, addedMatches: preview.addedMatches, affectedMatches: preview.affectedMatches.length };
    });
}
export async function resetOperations(db: Db, actor: SessionUser, planId: string) {
    return db.transaction(async (tx) => {
        await lockEvent(tx, planId);
        await requireOperator(tx, planId, actor);
        const matches = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
        const reports = await tx.select().from(eventScoreReports).where(eq(eventScoreReports.eventPlanId, planId)).limit(1);
        const brackets = await tx.select().from(eventPlanBrackets).where(eq(eventPlanBrackets.eventPlanId, planId));
        const withdrawals = await tx.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, planId));
        if (matches.some(m => m.status === 'playing' || m.status === 'complete' || m.score1 !== null || m.score2 !== null || m.liveScore1 !== null || m.liveScore2 !== null) || reports.length || withdrawals.length || brackets.some(b => b.tournamentId || b.challongeSlug))
            throw new TRPCError({ code: 'CONFLICT', message: 'Only an unplayed queue with no reports, withdrawals, or linked brackets can be reset.' });
        await tx.delete(eventMatches).where(eq(eventMatches.eventPlanId, planId));
        await tx.delete(eventPoolAssignments).where(eq(eventPoolAssignments.eventPlanId, planId));
        await tx.delete(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId, planId));
        await tx.delete(eventPlanPoolPlacements).where(eq(eventPlanPoolPlacements.eventPlanId, planId));
        await tx.insert(eventAttendanceAudit).values({ eventPlanId: planId, userId: actor.id, action: 'reset_queue', details: { removedMatches: matches.length } });
        return { removedMatches: matches.length };
    });
}
