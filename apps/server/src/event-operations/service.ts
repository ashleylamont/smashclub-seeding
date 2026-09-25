import { attendeeScoreDecision, samePlayedScore } from './scorePolicy';
import { loadStationQueues } from './queue';
import { advanceNativeBrackets, assertNativeCorrectionAllowed, nativeBracketViews } from './nativeBrackets';
import { and, asc, desc, eq, inArray, gt, isNull, or } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventAnnouncements, eventMatchAudit, eventMatches, eventOperationSettings, eventOperators, eventPlanBrackets, eventPlanEntries, eventPlanPoolPlacements, eventPlans, eventPrizes, eventScoreReports, eventStations, eventWithdrawals, eventPoolSchedules, playerCharacters, players, sets, tournaments, type Db } from '@smashclub/db';
import { publicPlayerName, scoresIndicateBye, scoresIndicateForfeit } from '@smashclub/shared';
import type { SessionUser } from '../auth';
import { getPlan } from '../event-planner/plans';
import { matchAvailability, stationAvailability } from './availability';
const fail = (code: 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND', message: string): never => { throw new TRPCError({ code, message }); };
export async function isOperator(db: Db, planId: string, user: SessionUser) {
    if (user.role === 'admin')
        return true;
    return !!(await db.select().from(eventOperators).where(and(eq(eventOperators.eventPlanId, planId), eq(eventOperators.userId, user.id))))[0];
}
export async function requireOperator(db: Db, planId: string, user: SessionUser) {
    if (!await isOperator(db, planId, user))
        fail('FORBIDDEN', 'You are not an organiser for this event.');
}
export async function lockEvent(db: Db, planId: string) {
    const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId)).for('update');
    if (!plan)
        return fail('NOT_FOUND', 'Event not found.');
    if (plan.status === 'complete' || plan.status === 'cancelled')
        fail('CONFLICT', 'This event is closed and read-only.');
    return plan;
}
export async function snapshot(db: Db, planId: string, privateView = false) {
    const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId));
    if (!plan)
        return fail('NOT_FOUND', 'Event not found.');
    const [settings] = await db.select().from(eventOperationSettings).where(eq(eventOperationSettings.eventPlanId, planId));
    if (!privateView && !settings?.published)
        fail('NOT_FOUND', 'This event is not published.');
    const names = new Map((await db.select().from(players)).map(p => [p.id, publicPlayerName(p)]));
    const rows = await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId)).orderBy(asc(eventMatches.label));
    const stations = await db.select().from(eventStations).where(eq(eventStations.eventPlanId,planId));
    const poolSchedules = await db.select().from(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId,planId));
    const participantIds=[...new Set(rows.flatMap(match=>[match.player1Id,match.player2Id].filter((id):id is string=>!!id)))];
    const characters=participantIds.length?await db.select().from(playerCharacters).where(inArray(playerCharacters.playerId,participantIds)).orderBy(asc(playerCharacters.position)):[];
    const disputes = await db.select({ matchId: eventScoreReports.matchId }).from(eventScoreReports).where(and(eq(eventScoreReports.eventPlanId, planId), eq(eventScoreReports.status, 'pending'), eq(eventScoreReports.isDispute, true)));
    const matches = rows.map(m => ({ ...m, pendingDisputeCount: disputes.filter(report => report.matchId === m.id).length,
        score1:m.status==='playing'?(m.liveScore1??m.score1):m.score1,score2:m.status==='playing'?(m.liveScore2??m.score2):m.score2,
        player1Name: m.player1Id ? names.get(m.player1Id) ?? 'Player' : 'TBD', player2Name: m.player2Id ? names.get(m.player2Id) ?? 'Player' : 'TBD',
        player1Characters:characters.filter(c=>c.playerId===m.player1Id).map(c=>c.characterSlug),player2Characters:characters.filter(c=>c.playerId===m.player2Id).map(c=>c.characterSlug),
        availability:matchAvailability(m,rows,stations,poolSchedules,false,!['complete','cancelled'].includes(plan.status)),
    }));
    const historicalResultsSlug = plan.historicalAdoption?.brackets.find(bracket => bracket.division === 'upper' && bracket.stage === 'main')?.slug ?? null;
    const [nativeResult] = plan.bracketMode === 'native' && plan.status === 'complete'
        ? await db.select({ slug: tournaments.challongeSlug }).from(eventPlanBrackets)
            .innerJoin(tournaments, eq(eventPlanBrackets.tournamentId, tournaments.id))
            .where(and(eq(eventPlanBrackets.eventPlanId, planId), eq(eventPlanBrackets.division, 'upper'), eq(eventPlanBrackets.stage, 'main')))
        : [];
    const resultsSlug = nativeResult?.slug ?? historicalResultsSlug;
    // Archived plans are planning intent, not evidence of attendance or finishes.
    const entrants = plan.historicalAdoption ? [] : (await db.select({ id: eventPlanEntries.playerId }).from(eventPlanEntries).where(eq(eventPlanEntries.eventPlanId, planId))).flatMap(p => p.id ? [{ id: p.id, name: names.get(p.id) ?? 'Player' }] : []);
    const prizes = (await db.select().from(eventPrizes).where(eq(eventPrizes.eventPlanId, planId))).map(p => ({ ...p, playerName: p.playerId ? names.get(p.playerId) ?? 'Player' : null }));
    return { ...await loadStationQueues(db, planId), nativeBrackets: await nativeBracketViews(db, planId), plan: { id: plan.id, name: plan.name, eventDate: plan.eventDate.toISOString(), status: plan.status, bracketMode: plan.bracketMode, historicalResultsSlug, resultsSlug }, brackets: (await db.select({ division: eventPlanBrackets.division, stage: eventPlanBrackets.stage, slug: eventPlanBrackets.challongeSlug }).from(eventPlanBrackets).where(eq(eventPlanBrackets.eventPlanId, planId))), settings: { scoreReportingMode: settings?.scoreReportingMode ?? 'to_review', published: settings?.published ?? false, playerReports: settings?.playerReports ?? false }, matches, entrants, prizes,
        stations: stations.map(station=>stationAvailability(station,rows)), poolSchedules,
        announcements: (await db.select().from(eventAnnouncements).where(and(eq(eventAnnouncements.eventPlanId, planId),or(isNull(eventAnnouncements.expiresAt),gt(eventAnnouncements.expiresAt,new Date())))).orderBy(desc(eventAnnouncements.createdAt))).map(a => ({ ...a, createdAt: a.createdAt.toISOString(),expiresAt:a.expiresAt?.toISOString()??null })),
        withdrawals: await db.select({ playerId: eventWithdrawals.playerId }).from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, planId)),
        placements: plan.historicalAdoption ? [] : await db.select().from(eventPlanPoolPlacements).where(eq(eventPlanPoolPlacements.eventPlanId, planId)) };
}
function importedOutcome(s: typeof sets.$inferSelect): 'played' | 'bye' | 'forfeit' | null {
    if (s.state !== 'complete')
        return null;
    return scoresIndicateBye(s.scoresCsv) ? 'bye' : scoresIndicateForfeit(s.scoresCsv) ? 'forfeit' : (!s.p1PlayerId || !s.p2PlayerId) ? 'bye' : 'played';
}
function remoteValues(s: typeof sets.$inferSelect, firstPlayerId: string) {
    const scores = s.scoresCsv?.match(/^(-?\d+)-(-?\d+)$/);
    const flipped = s.p1PlayerId !== firstPlayerId;
    return { sourceSetId: s.id, outcome: importedOutcome(s), status: s.state === 'complete' ? 'complete' as const : 'ready' as const, score1: scores ? Number(scores[flipped ? 2 : 1]) : null, score2: scores ? Number(scores[flipped ? 1 : 2]) : null, winnerId: s.winner === 1 ? s.p1PlayerId : s.winner === 2 ? s.p2PlayerId : null, syncState: 'synced' as const };
}
export async function prepare(db: Db, planId: string) {
    return db.transaction(async (tx) => {
        const row = await lockEvent(tx, planId);
        if (!['pools_ready', 'underway'].includes(row.status))
            fail('CONFLICT', 'Generate and freeze pools before preparing matches.');
        const plan = await getPlan(tx, planId);
        if (!plan)
            return fail('NOT_FOUND', 'Event not found.');
        const existing = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
        const linked = await tx.select().from(eventPlanBrackets).where(eq(eventPlanBrackets.eventPlanId, planId));
        const imported = row.bracketMode !== 'native' && linked.length ? await tx.select().from(sets).where(inArray(sets.tournamentId, linked.flatMap(b => b.tournamentId ? [b.tournamentId] : []))) : [];
        const rows: Array<typeof eventMatches.$inferInsert> = [];
        for (const d of plan.divisions)
            for (const pool of d.pools)
                for (let i = 0; i < pool.members.length; i++)
                    for (let j = i + 1; j < pool.members.length; j++) {
                        const a = pool.members[i]!, b = pool.members[j]!;
                        const remote = imported.find(s => linked.some(b => b.tournamentId === s.tournamentId && b.division === d.division && b.stage === 'main') && s.resultStage === 'group' && ((s.p1PlayerId === a.playerId && s.p2PlayerId === b.playerId) || (s.p2PlayerId === a.playerId && s.p1PlayerId === b.playerId)));
                        rows.push({ eventPlanId: planId, sourceKey: `group:${d.division}:${pool.poolIndex}:${[a.playerId, b.playerId].sort().join(':')}`, division: d.division, stage: 'group', poolIndex: pool.poolIndex, label: `${d.division} Pool ${pool.label} · ${i + 1} v ${j + 1}`, player1Id: a.playerId, player2Id: b.playerId, ...(remote ? remoteValues(remote, a.playerId) : {}) });
                    }
        for (const s of imported.filter(s => s.resultStage !== 'group')) {
            const b = linked.find(b => b.tournamentId === s.tournamentId)!;
            const scores = s.scoresCsv?.match(/^(-?\d+)-(-?\d+)$/);
            rows.push({ eventPlanId: planId, sourceKey: `set:${s.id}`, sourceSetId: s.id, outcome: importedOutcome(s), division: b.division, stage: b.stage, poolIndex: null, label: `${b.division} ${b.stage} · ${s.identifier ?? s.suggestedPlayOrder ?? s.challongeMatchId}`, player1Id: s.p1PlayerId, player2Id: s.p2PlayerId, status: s.state === 'complete' ? 'complete' : s.p1PlayerId && s.p2PlayerId ? 'ready' : 'blocked', blockedReason: s.p1PlayerId && s.p2PlayerId ? null : 'Waiting for bracket participants', score1: scores ? Number(scores[1]) : null, score2: scores ? Number(scores[2]) : null, winnerId: s.winner === 1 ? s.p1PlayerId : s.winner === 2 ? s.p2PlayerId : null, syncState: 'synced' });
        }
        const desired = new Set(rows.map(r => r.sourceKey));
        if (existing.some(m => !m.nativeBracketId && !desired.has(m.sourceKey)))
            fail('CONFLICT', 'Pool assignments changed. Existing operational matches must be reconciled before preparing again.');
        for (const row of rows) {
            const previous = existing.find(m => m.sourceKey === row.sourceKey);
            if (!previous) {
                await tx.insert(eventMatches).values({ ...row, resultUpdatedAt: row.status === 'complete' ? new Date() : null });
                continue;
            }
            if (!row.sourceSetId)
                continue;
            if (previous.status === 'complete' && (previous.syncState === 'pending' || previous.syncState === 'error' || (previous.revision > 0 && previous.syncState === 'local'))) {
                const agrees = row.status === 'complete' && row.player1Id === previous.player1Id && row.player2Id === previous.player2Id && row.score1 === previous.score1 && row.score2 === previous.score2 && row.winnerId === previous.winnerId && row.outcome === previous.outcome;
                await tx.update(eventMatches).set({ sourceSetId: row.sourceSetId, syncState: agrees ? 'synced' : 'error', blockedReason: agrees ? null : 'Local result differs from the imported Challonge result. Copy the correction to Challonge, sync that bracket, then refresh matches.' }).where(eq(eventMatches.id, previous.id));
                continue;
            }
            // Refresh only imported facts; preserve local station/queue decisions. Changed facts
            // invalidate forms and pending player reports by advancing the revision.
            const importedStatus = row.status ?? 'ready';
            const participantsChanged = previous.player1Id !== (row.player1Id ?? null) || previous.player2Id !== (row.player2Id ?? null);
            const requiresParticipantReview = importedStatus !== 'complete' && participantsChanged && (previous.status === 'playing' || previous.liveScore1 !== null || previous.liveScore2 !== null || !!previous.player1Id && previous.player1Id !== row.player1Id || !!previous.player2Id && previous.player2Id !== row.player2Id);
            const nextStatus = importedStatus === 'complete' ? 'complete' : requiresParticipantReview ? 'blocked' : !row.player1Id || !row.player2Id ? 'blocked' : previous.status === 'playing' ? 'playing' : previous.status === 'blocked' && previous.blockedReason !== 'Waiting for bracket participants' ? 'blocked' : 'ready';
            const fields = { sourceSetId: row.sourceSetId, player1Id: row.player1Id ?? null, player2Id: row.player2Id ?? null, score1: row.score1 ?? null, score2: row.score2 ?? null, winnerId: row.winnerId ?? null, outcome: row.outcome ?? null, syncState: 'synced' as const };
            if (Object.entries(fields).some(([key, value]) => previous[key as keyof typeof previous] !== value) || nextStatus !== previous.status) {
                let reconciliationReason:string|null=null;
                const resultChanged=previous.status==='complete'&&(nextStatus!=='complete'||previous.score1!==fields.score1||previous.score2!==fields.score2||previous.winnerId!==fields.winnerId||previous.outcome!==fields.outcome);
                if(previous.stage==='group'&&previous.poolIndex!==null&&resultChanged){
                    await tx.delete(eventPlanPoolPlacements).where(and(eq(eventPlanPoolPlacements.eventPlanId,planId),eq(eventPlanPoolPlacements.division,previous.division),eq(eventPlanPoolPlacements.poolIndex,previous.poolIndex)));
                    reconciliationReason='Imported pool result changed. Reconfirm this pool order and reconcile any downstream bracket entrants.';
                    for(const bracket of linked.filter(b=>b.division===previous.division&&b.stage==='consolation'&&(b.challongeSlug||b.tournamentId))){
                        await tx.update(eventPlanBrackets).set({externalState:'error',lastError:reconciliationReason,updatedAt:new Date()}).where(eq(eventPlanBrackets.id,bracket.id));
                    }
                }
                const newResult = nextStatus === 'complete' && (previous.status !== 'complete' || resultChanged || previous.player1Id !== fields.player1Id || previous.player2Id !== fields.player2Id);
                await tx.update(eventMatches).set({ ...fields, ...(nextStatus==='complete'||requiresParticipantReview?{liveScore1:null,liveScore2:null}:{}), resultUpdatedAt: newResult ? new Date() : nextStatus === 'complete' ? previous.resultUpdatedAt : null, status: nextStatus, blockedReason: requiresParticipantReview ? 'Imported bracket participants changed. Previous live scores were cleared; review the players before releasing this match.' : reconciliationReason??(!fields.player1Id || !fields.player2Id ? 'Waiting for bracket participants' : nextStatus === 'blocked' ? previous.blockedReason : null), revision: previous.revision + 1 }).where(eq(eventMatches.id, previous.id));
            }
        }
        const withdrawn = await tx.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, planId));
        const withdrawnIds = new Set(withdrawn.map(w => w.playerId));
        const outstanding = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
        for (const m of outstanding.filter(m => m.status !== 'complete' && ((m.player1Id && withdrawnIds.has(m.player1Id)) || (m.player2Id && withdrawnIds.has(m.player2Id))) && m.blockedReason !== (m.player1Id&&m.player2Id&&withdrawnIds.has(m.player1Id)&&withdrawnIds.has(m.player2Id)?'Both players withdrawn: no contest; no winner or score recorded':'Player withdrawn: awaiting organiser forfeit decision')))
            await tx.update(eventMatches).set({ status: 'blocked', blockedReason: m.player1Id&&m.player2Id&&withdrawnIds.has(m.player1Id)&&withdrawnIds.has(m.player2Id)?'Both players withdrawn: no contest; no winner or score recorded':'Player withdrawn: awaiting organiser forfeit decision', revision: m.revision + 1 }).where(eq(eventMatches.id, m.id));
        await tx.insert(eventOperationSettings).values({ eventPlanId: planId }).onConflictDoNothing();
        return { created: rows.filter(r => !existing.some(m => m.sourceKey === r.sourceKey)).length };
    });
}
export interface ScoreInput {
    matchId: string;
    expectedRevision: number;
    requestId: string;
    score1: number;
    score2: number;
    outcome: 'played' | 'bye' | 'forfeit';
    winnerId?: string;
}
export function validateScore(match: {
    player1Id: string | null;
    player2Id: string | null;
}, input: ScoreInput) {
    if (input.outcome === 'played' && (input.score1 > 5 || input.score2 > 5))
        fail('BAD_REQUEST', 'A played score cannot use a bye sentinel. Select a forfeit or bye outcome.');
    if (input.outcome === 'played' && (!match.player1Id || !match.player2Id || input.score1 === input.score2))
        fail('BAD_REQUEST', 'Played matches need two players and a decisive score.');
    if (input.outcome === 'bye' && !!match.player1Id === !!match.player2Id)
        fail('BAD_REQUEST', 'A bye must have exactly one player.');
    const winner = input.winnerId ?? (input.score1 > input.score2 ? match.player1Id : input.score2 > input.score1 ? match.player2Id : null);
    if (!winner || ![match.player1Id, match.player2Id].includes(winner))
        return fail('BAD_REQUEST', 'Select a participating winner.');
    if (input.outcome === 'played' && winner !== (input.score1 > input.score2 ? match.player1Id : match.player2Id))
        fail('BAD_REQUEST', 'Winner disagrees with score.');
    return winner;
}
async function matchForUpdate(db: Db, id: string) {
    const [match] = await db.select().from(eventMatches).where(eq(eventMatches.id, id));
    if (!match)
        return fail('NOT_FOUND', 'Match not found.');
    await lockEvent(db, match.eventPlanId);
    // Refresh after acquiring event lock: another TO may have written while we waited.
    return (await db.select().from(eventMatches).where(eq(eventMatches.id, id)))[0]!;
}
export async function applyScore(db: Db, match: typeof eventMatches.$inferSelect, input: ScoreInput, winnerId: string, actor: string | null, guestSessionId: string | null = null) {
    await assertNativeCorrectionAllowed(db, match);
    if (match.revision !== input.expectedRevision)
        fail('CONFLICT', 'This match changed. Refresh before recording a correction.');
    if (match.stage === 'group' && match.status === 'complete' && (match.score1 !== input.score1 || match.score2 !== input.score2 || match.winnerId !== winnerId || match.outcome !== input.outcome)) {
        const attached = await db.select().from(eventPlanBrackets).where(and(eq(eventPlanBrackets.eventPlanId, match.eventPlanId), eq(eventPlanBrackets.division, match.division), eq(eventPlanBrackets.stage, 'consolation')));
        if (attached.some(b => b.challongeSlug || b.tournamentId))
            fail('CONFLICT', 'This pool has a linked consolation bracket. Reconcile downstream entrants before correcting its result.');
        if (match.poolIndex !== null)
            await db.delete(eventPlanPoolPlacements).where(and(eq(eventPlanPoolPlacements.eventPlanId, match.eventPlanId), eq(eventPlanPoolPlacements.division, match.division), eq(eventPlanPoolPlacements.poolIndex, match.poolIndex)));
    }
    const [updated] = await db.update(eventMatches).set({ score1: input.score1, score2: input.score2, liveScore1:null,liveScore2:null, winnerId, outcome: input.outcome, status: 'complete', resultUpdatedAt: new Date(), blockedReason: null, revision: match.revision + 1, syncState: match.sourceSetId ? 'pending' : 'local' }).where(and(eq(eventMatches.id, match.id), eq(eventMatches.revision, input.expectedRevision))).returning();
    if (!updated)
        return fail('CONFLICT', 'Another organiser updated this match.');
    await db.insert(eventMatchAudit).values({ eventPlanId: match.eventPlanId, matchId: match.id, userId: actor, guestSessionId, action: match.status === 'complete' ? 'score_corrected' : 'score_recorded', before: match, after: updated });
    await advanceNativeBrackets(db, match.eventPlanId);
    return updated;
}
export async function reportScore(db: Db, user: SessionUser, input: ScoreInput) {
    return db.transaction(async (tx) => {
        const match = await matchForUpdate(tx, input.matchId);
        const [prior] = await tx.select().from(eventScoreReports).where(and(eq(eventScoreReports.userId, user.id), eq(eventScoreReports.requestId, input.requestId)));
        if (prior) {
            if (prior.matchId !== input.matchId || (prior.submittedRevision ?? prior.expectedRevision) !== input.expectedRevision || prior.score1 !== input.score1 || prior.score2 !== input.score2 || prior.outcome !== input.outcome || (input.winnerId && input.winnerId !== prior.winnerId))
                fail('CONFLICT', 'Request identifier already used for a different score.');
            return prior;
        }
        const operator = await isOperator(tx, match.eventPlanId, user);
        if (!operator) {
            const [settings] = await tx.select().from(eventOperationSettings).where(eq(eventOperationSettings.eventPlanId, match.eventPlanId));
            if (!settings?.published || !settings.playerReports)
                fail('FORBIDDEN', 'Score reporting is unavailable for this event.');
            if (input.outcome !== 'played')
                fail('CONFLICT', 'Ask an organiser to record byes, forfeits, blocked matches or corrections.');
            const reports = await tx.select().from(eventScoreReports).where(and(eq(eventScoreReports.eventPlanId, match.eventPlanId), eq(eventScoreReports.userId, user.id)));
            if (reports.some(report => report.matchId === match.id && report.status === 'pending'))
                fail('CONFLICT', 'Your score is already waiting for organiser approval.');
            if (reports.filter(report => report.status === 'pending').length >= 30 || reports.filter(report => report.createdAt.getTime() > Date.now() - 60_000).length >= 6)
                throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many score reports. Please wait or ask an organiser.' });
        }
        if (operator && match.revision !== input.expectedRevision)
            fail('CONFLICT', 'This match changed. Refresh and try again.');
        if (input.outcome === 'bye' && match.sourceSetId && match.status === 'blocked')
            fail('BAD_REQUEST', 'An unresolved bracket opponent is not a confirmed bye. Resolve it in Challonge first.');
        const withdrawn = await tx.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, match.eventPlanId));
        if(match.player1Id&&match.player2Id&&[match.player1Id,match.player2Id].every(id=>withdrawn.some(w=>w.playerId===id))&&match.status!=='complete')fail('CONFLICT','Both players withdrew. This is an unplayed no contest with no winner.');
        if (input.outcome === 'played' && withdrawn.some(w => [match.player1Id, match.player2Id].includes(w.playerId)) && match.status !== 'complete')
            fail('CONFLICT', 'A player has withdrawn. Record an explicit forfeit rather than a played result.');
        if (!operator && withdrawn.some(w => [match.player1Id, match.player2Id].includes(w.playerId))) fail('CONFLICT', 'A player withdrew. Ask an organiser to resolve this match.');
        const winnerId = validateScore(match, input);
        if(match.status!=='complete'&&withdrawn.some(w=>w.playerId===winnerId))fail('BAD_REQUEST','A withdrawn entrant cannot win an outstanding match. Select the active opponent for the forfeit.');
        const decision = operator ? { apply: true, status: 'approved' as const, autoApproved: false, isDispute: false, expectedRevision: input.expectedRevision } : await attendeeScoreDecision(tx, match, input, winnerId);
        if (decision.apply) await applyScore(tx, match, input, winnerId, user.id);
        const reportDecision = { status: decision.status, expectedRevision: decision.expectedRevision, autoApproved: decision.autoApproved, isDispute: decision.isDispute };
        const [report] = await tx.insert(eventScoreReports).values({ ...input, ...reportDecision, submittedRevision: input.expectedRevision, eventPlanId: match.eventPlanId, userId: user.id, winnerId }).returning();
        return report!;
    });
}
export async function reviewReport(db: Db, user: SessionUser, reportId: string, approve: boolean) {
    return db.transaction(async (tx) => {
        const [report] = await tx.select().from(eventScoreReports).where(eq(eventScoreReports.id, reportId));
        if (!report)
            return fail('NOT_FOUND', 'Report not found.');
        await requireOperator(tx, report.eventPlanId, user);
        const match = await matchForUpdate(tx, report.matchId);
        const [fresh] = await tx.select().from(eventScoreReports).where(eq(eventScoreReports.id, reportId));
        if (fresh!.status !== 'pending')
            return fresh!;
        if (approve && !(fresh!.isDispute && fresh!.expectedRevision === match.revision && samePlayedScore(match, fresh!, fresh!.winnerId)))
            await applyScore(tx, match, { ...fresh! }, fresh!.winnerId, user.id);
        const [updated] = await tx.update(eventScoreReports).set({ status: approve ? 'approved' : 'rejected' }).where(eq(eventScoreReports.id, reportId)).returning();
        return updated!;
    });
}
export async function updateMatch(db: Db, user: SessionUser, input: {
    matchId: string;
    expectedRevision: number;
    status: 'ready' | 'playing' | 'blocked';
    stationId?: string | null;
    blockedReason?: string | null;
}) {
    return db.transaction(async (tx) => {
        const match = await matchForUpdate(tx, input.matchId);
        await requireOperator(tx, match.eventPlanId, user);
        if (match.revision !== input.expectedRevision || match.status === 'complete')
            fail('CONFLICT', 'Match changed or completed; refresh before editing.');
        let stationId = input.stationId === undefined ? match.stationId : input.stationId;
        if (stationId && !(await tx.select().from(eventStations).where(and(eq(eventStations.id, stationId), eq(eventStations.eventPlanId, match.eventPlanId))))[0])
            fail('BAD_REQUEST', 'Station belongs to another event.');
        if (input.status === 'playing') {
            const withdrawn = await tx.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, match.eventPlanId));
            if (withdrawn.some(w => [match.player1Id, match.player2Id].includes(w.playerId)))
                fail('CONFLICT', 'A withdrawn player cannot start another match.');
            if (!match.player1Id || !match.player2Id)
                fail('BAD_REQUEST', 'Both players must be known before starting.');
            const allMatches=await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId,match.eventPlanId));
            const stations=await tx.select().from(eventStations).where(eq(eventStations.eventPlanId,match.eventPlanId));
            const schedules=await tx.select().from(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId,match.eventPlanId));
            const availability=matchAvailability({...match,stationId},allMatches,stations,schedules,true);
            if(!availability.canStart)fail('CONFLICT',availability.reasons.map(reason=>reason.message).join(' '));
            if (!stationId && stations.length) stationId = availability.eligibleStationIds[0] ?? null;
        }
        const [updated] = await tx.update(eventMatches).set({ status: input.status, stationId, blockedReason: input.status === 'blocked' ? input.blockedReason ?? 'Organiser hold' : null, revision: match.revision + 1 }).where(eq(eventMatches.id, match.id)).returning();
        await tx.insert(eventMatchAudit).values({ eventPlanId: match.eventPlanId, matchId: match.id, userId: user.id, action: 'match_updated', before: match, after: updated });
        return updated!;
    });
}
