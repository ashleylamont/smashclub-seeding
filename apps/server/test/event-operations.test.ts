import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches, eventMatchAudit, eventOperationSettings, eventOperators, eventPlanBrackets, eventPlanEntries, eventPlanPoolPlacements, eventPlans, eventScoreReports, eventStations, eventPoolAssignments, eventWithdrawals, playerClaims, players, sets, tournaments, user, type Db } from '@smashclub/db';
import { prepare, reportScore, reviewReport, snapshot, updateMatch, requireOperator } from '../src/event-operations/service';
import { applyAttendance, previewAttendance, resetOperations } from '../src/event-operations/attendance';
import { getPlan, unfreezeRoster, reorderDivision, generatePools, savePoolPlacements } from '../src/event-planner/plans';
import { createTestDb } from './helpers/testDb';
import type { SessionUser } from '../src/auth';
let db: Db;
let close: () => Promise<void>;
let planId: string;
let ids: string[];
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const member: SessionUser = { id: 'member', role: 'user', name: 'Player', email: 'player@example.test' };
beforeEach(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values([admin, member]);
    ids = (await db.insert(players).values(Array.from({ length: 8 }, (_, i) => ({ canonicalName: `Private Name ${i}`, displayName: `Alias${i}` }))).returning()).map(p => p.id);
    planId = (await db.insert(eventPlans).values({ name: 'Rehearsal', eventDate: new Date(), status: 'pools_ready' }).returning())[0]!.id;
    await db.insert(eventPlanEntries).values(ids.map((id, i) => ({ eventPlanId: planId, sourceLineNumber: i + 1, rawInput: 'Private', cleanedName: 'Private', playerId: id, assignedDivision: i < 4 ? 'upper' as const : 'lower' as const, divisionSeed: i % 4 + 1 })));
});
afterEach(async () => close());
const score = (m: typeof eventMatches.$inferSelect, requestId = 'r1') => ({ matchId: m.id, expectedRevision: m.revision, requestId, score1: 2, score2: 0, outcome: 'played' as const });
async function ready() { await prepare(db, planId); return (await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId))); }
describe('event operations', () => {
    it('prepares all pairs idempotently, gates publication, exposes safe aliases', async () => {
        expect(await prepare(db, planId)).toEqual({ created: 12 });
        expect(await prepare(db, planId)).toEqual({ created: 0 });
        await expect(snapshot(db, planId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await db.update(eventOperationSettings).set({ published: true }).where(eq(eventOperationSettings.eventPlanId, planId));
        const publicView = await snapshot(db, planId);
        expect(publicView.matches).toHaveLength(12);
        expect(JSON.stringify(publicView)).not.toContain('Private');
    });
    it('retries once, rejects stale updates, and audits corrections', async () => {
        const [m] = await ready();
        const input = score(m!);
        await reportScore(db, admin, input);
        await reportScore(db, admin, input);
        expect(await db.select().from(eventMatchAudit)).toHaveLength(1);
        await expect(reportScore(db, admin, { ...input, requestId: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(reportScore(db, admin, { ...input, score1: 3 })).rejects.toMatchObject({ code: 'CONFLICT' });
        await reportScore(db, admin, { ...input, requestId: 'correction', expectedRevision: 1, score1: 0, score2: 2 });
        expect((await db.select().from(eventMatchAudit))).toHaveLength(2);
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, m!.id)))[0]).toMatchObject({ revision: 2, winnerId: m!.player2Id, syncState: 'local' });
    });
    it('allows assigned TOs only in their event and serialises station/player conflicts', async () => {
        await expect(requireOperator(db, planId, member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await db.insert(eventOperators).values({ eventPlanId: planId, userId: member.id });
        await requireOperator(db, planId, member);
        const matches = await ready();
        const m = matches[0]!;
        const other = matches.find(x => x.player1Id !== m.player1Id && x.player2Id !== m.player1Id && x.player1Id !== m.player2Id && x.player2Id !== m.player2Id)!;
        const [station] = await db.insert(eventStations).values({ eventPlanId: planId, name: 'Stage' }).returning();
        await updateMatch(db, member, { matchId: m.id, expectedRevision: 0, status: 'playing', stationId: station!.id });
        await expect(updateMatch(db, member, { matchId: other.id, expectedRevision: 0, status: 'playing', stationId: station!.id })).rejects.toMatchObject({ code: 'CONFLICT' });
        const overlap = matches.find(x => x.id !== m.id && [x.player1Id, x.player2Id].includes(m.player1Id))!;
        await expect(updateMatch(db, member, { matchId: overlap.id, expectedRevision: 0, status: 'playing' })).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    it('keeps player reports pending and prevents stale approval overwriting TO corrections', async () => {
        const [m] = await ready();
        await db.update(eventOperationSettings).set({ playerReports: true }).where(eq(eventOperationSettings.eventPlanId, planId));
        await expect(reportScore(db, member, score(m!))).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await db.insert(playerClaims).values({ userId: member.id, playerId: m!.player1Id!, status: 'approved' });
        const r = await reportScore(db, member, score(m!));
        expect(r.status).toBe('pending');
        expect(await db.select().from(eventMatchAudit)).toHaveLength(0);
        await reportScore(db, admin, score(m!, 'to-result'));
        await expect(reviewReport(db, admin, r.id, true)).rejects.toMatchObject({ code: 'CONFLICT' });
        await reviewReport(db, admin, r.id, false);
        expect((await db.select().from(eventScoreReports).where(eq(eventScoreReports.id, r.id)))[0]!.status).toBe('rejected');
    });
    it('approves a valid report and makes closed events read-only', async () => {
        const [m] = await ready();
        await db.update(eventOperationSettings).set({ playerReports: true }).where(eq(eventOperationSettings.eventPlanId, planId));
        await db.insert(playerClaims).values({ userId: member.id, playerId: m!.player1Id!, status: 'approved' });
        const r = await reportScore(db, member, score(m!));
        await reviewReport(db, admin, r.id, true);
        await reviewReport(db, admin, r.id, true);
        expect(await db.select().from(eventMatchAudit)).toHaveLength(1);
        await db.update(eventPlans).set({ status: 'complete' }).where(eq(eventPlans.id, planId));
        await expect(reportScore(db, admin, { ...score(m!, 'closed'), expectedRevision: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    it('classifies imported bye and forfeit sentinels as unplayed outcomes', async () => {
        const [t] = await db.insert(tournaments).values({ challongeSlug: 'outcomes', name: 'Outcomes' }).returning();
        await db.insert(eventPlanBrackets).values({ eventPlanId: planId, division: 'upper', stage: 'main', tournamentId: t!.id });
        await db.insert(sets).values([{ tournamentId: t!.id, challongeMatchId: 11, state: 'complete', resultStage: 'group', p1PlayerId: ids[0], p2PlayerId: ids[1], scoresCsv: '99-0', winner: 1 }, { tournamentId: t!.id, challongeMatchId: 12, state: 'complete', resultStage: 'final', p1PlayerId: ids[0], p2PlayerId: ids[2], scoresCsv: '-1-0', winner: 2 }]);
        await prepare(db, planId);
        const rows = await db.select().from(eventMatches);
        expect(rows.find(m => m.sourceSetId && m.stage === 'group')!.outcome).toBe('bye');
        expect(rows.find(m => m.stage === 'main')!.outcome).toBe('forfeit');
    });
    it('imports group results with correct orientation and refreshes unknown finals without overwriting local scores', async () => {
        const matches = await ready();
        const group = matches.find(m => m.division === 'upper')!;
        const [t] = await db.insert(tournaments).values({ challongeSlug: 'upper-test', name: 'Upper' }).returning();
        await db.insert(eventPlanBrackets).values({ eventPlanId: planId, division: 'upper', stage: 'main', tournamentId: t!.id });
        await db.insert(sets).values({ tournamentId: t!.id, challongeMatchId: 1, state: 'complete', resultStage: 'group', p1PlayerId: group.player2Id, p2PlayerId: group.player1Id, scoresCsv: '2-1', winner: 1 });
        const [final] = await db.insert(sets).values({ tournamentId: t!.id, challongeMatchId: 2, state: 'pending', resultStage: 'final' }).returning();
        await prepare(db, planId);
        let row = (await db.select().from(eventMatches).where(eq(eventMatches.id, group.id)))[0]!;
        expect(row).toMatchObject({ score1: 1, score2: 2, status: 'complete', winnerId: group.player2Id, syncState: 'synced' });
        const importedAt = row.resultUpdatedAt;
        expect(importedAt).toBeInstanceOf(Date);
        await prepare(db, planId);
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, group.id)))[0]!.resultUpdatedAt).toEqual(importedAt);
        await reportScore(db, admin, { ...score(row), score1: 2, score2: 0 });
        await db.update(sets).set({ p1PlayerId: ids[0], p2PlayerId: ids[1], state: 'open' }).where(eq(sets.id, final!.id));
        await prepare(db, planId);
        row = (await db.select().from(eventMatches).where(eq(eventMatches.id, group.id)))[0]!;
        expect(row).toMatchObject({ score1: 2, score2: 0, syncState: 'error' });
        expect((await db.select().from(eventMatches).where(eq(eventMatches.sourceSetId, final!.id)))[0]).toMatchObject({ status: 'ready', player1Id: ids[0], player2Id: ids[1] });
        await db.update(sets).set({ scoresCsv: '0-2', winner: 2 }).where(eq(sets.challongeMatchId, 1));
        await prepare(db, planId);
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, group.id)))[0]!.syncState).toBe('synced');
        await db.update(sets).set({ scoresCsv: null, winner: null, state: 'open' }).where(eq(sets.challongeMatchId, 1));
        await prepare(db, planId);
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, group.id)))[0]).toMatchObject({ status: 'ready', score1: null, winnerId: null });
    });
});
describe('late attendance and protected pools', () => {
    it('appends a late player without moving existing members or losing completed scores', async () => {
        const matches = await ready();
        const match = matches.find(m => m.division === 'upper')!;
        await reportScore(db, admin, score(match));
        const before = (await getPlan(db, planId))!;
        const [late] = await db.insert(players).values({ canonicalName: 'Late Arrival', displayName: 'Late' }).returning();
        const input = { planId, action: 'add' as const, playerId: late!.id, division: 'upper' as const, poolIndex: 0 };
        const preview = await previewAttendance(db, input);
        expect(preview).toMatchObject({ allowed: true, addedMatches: 4, poolSize: 4 });
        await applyAttendance(db, admin, { ...input, revisionToken: preview.revisionToken });
        const after = (await getPlan(db, planId))!;
        expect(after.divisions[0]!.pools[0]!.members.map(m => m.playerId)).toEqual([...before.divisions[0]!.pools[0]!.members.map(m => m.playerId), late!.id]);
        expect(after.divisions[1]!.pools).toEqual(before.divisions[1]!.pools);
        expect(await db.select().from(eventMatches)).toHaveLength(16);
        expect((await db.select().from(eventMatches).where(eq(eventMatches.id, match.id)))[0]).toMatchObject({ score1: 2, status: 'complete' });
        expect(await db.select().from(eventPoolAssignments)).toHaveLength(9);
        const [extra] = await db.insert(players).values({ canonicalName: 'Too many' }).returning();
        expect((await previewAttendance(db, { ...input, playerId: extra!.id })).allowed).toBe(false);
    });
    it('rejects stale attendance previews when another TO changes a match', async () => {
        const [m] = await ready();
        const input = { planId, action: 'withdraw' as const, playerId: m!.player1Id! };
        const preview = await previewAttendance(db, input);
        await reportScore(db, admin, score(m!));
        await expect(applyAttendance(db, admin, { ...input, revisionToken: preview.revisionToken })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await db.select().from(eventWithdrawals)).toHaveLength(0);
    });
    it('withdraws without inventing scores, retains history, and requires explicit forfeits', async () => {
        const matches = await ready();
        const m = matches[0]!;
        await reportScore(db, admin, score(m));
        const input = { planId, action: 'withdraw' as const, playerId: m.player1Id!, reason: 'Went home' };
        const preview = await previewAttendance(db, input);
        await applyAttendance(db, admin, { ...input, revisionToken: preview.revisionToken });
        const affected = (await db.select().from(eventMatches)).filter(x => x.player1Id === m.player1Id || x.player2Id === m.player1Id);
        expect(affected.find(x => x.id === m.id)!.status).toBe('complete');
        expect(affected.filter(x => x.id !== m.id).every(x => x.status === 'blocked' && x.score1 === null)).toBe(true);
        const held = affected.find(x => x.id !== m.id)!;
        await expect(updateMatch(db, admin, { matchId: held.id, expectedRevision: held.revision, status: 'playing' })).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(reportScore(db, admin, score(held, 'played-withdrawn'))).rejects.toMatchObject({ code: 'CONFLICT' });
        await reportScore(db, admin, { ...score(held, 'forfeit'), outcome: 'forfeit', winnerId: held.player1Id === m.player1Id ? held.player2Id! : held.player1Id! });
        expect((await getPlan(db, planId))!.issues.warnings.some(i => i.code === 'withdrawal_advancement')).toBe(true);
    });
    it('guards pool mutations until a genuinely unplayed queue is explicitly reset', async () => {
        await ready();
        await expect(unfreezeRoster(db, planId)).rejects.toThrow('Operational matches');
        await expect(generatePools(db, planId)).rejects.toThrow('Operational matches');
        const view = (await getPlan(db, planId))!;
        await expect(reorderDivision(db, planId, 'upper', view.entries.filter(e => e.assignedDivision === 'upper').map(e => e.id))).rejects.toThrow('Operational matches');
        expect(await resetOperations(db, admin, planId)).toEqual({ removedMatches: 12 });
        await unfreezeRoster(db, planId);
        expect((await getPlan(db, planId))!.plan.status).toBe('draft');
    });
    it('requires acknowledgement for linked roster changes and refuses reset after scoring', async () => {
        const [m] = await ready();
        await db.insert(eventPlanBrackets).values({ eventPlanId: planId, division: 'upper', stage: 'main', challongeSlug: 'linked' });
        const [late] = await db.insert(players).values({ canonicalName: 'Late' }).returning();
        const input = { planId, action: 'add' as const, playerId: late!.id, division: 'upper' as const, poolIndex: 0 };
        const preview = await previewAttendance(db, input);
        expect(preview.requiresExternalAcknowledgement).toBe(true);
        await expect(applyAttendance(db, admin, { ...input, revisionToken: preview.revisionToken })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await applyAttendance(db, admin, { ...input, revisionToken: preview.revisionToken, acknowledgeExternalChange: true });
        await reportScore(db, admin, score(m!));
        await expect(resetOperations(db, admin, planId)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
});

describe('withdrawal advancement recovery',()=>{
 it('requires fresh completed results then advances only active entrants in confirmed order',async()=>{
   await ready();
   const input={planId,action:'withdraw' as const,playerId:ids[0]!};
   await applyAttendance(db,admin,{...input,revisionToken:(await previewAttendance(db,input)).revisionToken});
   let view=(await getPlan(db,planId))!;let pool=view.divisions[0]!.pools[0]!;
   const order=[ids[0]!,ids[1]!,ids[2]!,ids[3]!];
   await expect(savePoolPlacements(db,planId,'upper',[{poolIndex:0,playerIdsInOrder:order,expectedMatchRevisions:pool.matchRevisions,expectedPlacementRevision:pool.placementRevision}])).rejects.toThrow('Record every pool result');
   const matches=(await db.select().from(eventMatches)).filter(m=>m.division==='upper');
   for(const m of matches)await reportScore(db,admin,{...score(m,`finish-${m.id}`),outcome:[m.player1Id,m.player2Id].includes(ids[0]!)?'forfeit':'played',winnerId:m.player1Id===ids[0]?m.player2Id!:m.player1Id!});
   await expect(savePoolPlacements(db,planId,'upper',[{poolIndex:0,playerIdsInOrder:order,expectedMatchRevisions:pool.matchRevisions,expectedPlacementRevision:pool.placementRevision}])).rejects.toThrow('Pool matches changed');
   view=(await getPlan(db,planId))!;pool=view.divisions[0]!.pools[0]!;
   await savePoolPlacements(db,planId,'upper',[{poolIndex:0,playerIdsInOrder:order,expectedMatchRevisions:pool.matchRevisions,expectedPlacementRevision:pool.placementRevision}]);
   const restored=(await getPlan(db,planId))!.divisions[0]!;
   expect(restored.championship.map(p=>p.playerId)).toEqual([ids[1],ids[2]]);
   expect(restored.consolation!.entrants.map(p=>p.playerId)).toEqual([ids[3]]);
   expect(restored.pools[0]!.members.find(m=>m.playerId===ids[0])!.place).toBe(1);
   await expect(savePoolPlacements(db,planId,'upper',[{poolIndex:0,playerIdsInOrder:[...order].reverse(),expectedMatchRevisions:pool.matchRevisions,expectedPlacementRevision:pool.placementRevision}])).rejects.toThrow('Pool placements changed');
 });
 it('invalidates a stale worksheet after a completed score is corrected',async()=>{
   const matches=(await ready()).filter(m=>m.division==='upper');
   for(const m of matches)await reportScore(db,admin,score(m,`finish-${m.id}`));
   const pool=(await getPlan(db,planId))!.divisions[0]!.pools[0]!;
   const order=pool.members.map(m=>m.playerId);
   const [m]=await db.select().from(eventMatches).where(eq(eventMatches.id,matches[0]!.id));
   await reportScore(db,admin,{...score(m!,'correction'),score1:0,score2:2});
   await expect(savePoolPlacements(db,planId,'upper',[{poolIndex:0,playerIdsInOrder:order,expectedMatchRevisions:pool.matchRevisions,expectedPlacementRevision:pool.placementRevision}])).rejects.toThrow('Pool matches changed');
   expect((await getPlan(db,planId))!.divisions[0]!.championship).toHaveLength(0);
 });
});

it('allows confirmed advancement past an unplayed no contest between two withdrawals',async()=>{
 await ready();
 for(const id of ids.slice(0,2)){const input={planId,action:'withdraw' as const,playerId:id};await applyAttendance(db,admin,{...input,revisionToken:(await previewAttendance(db,input)).revisionToken});}
 const matches=(await db.select().from(eventMatches)).filter(m=>m.division==='upper');
 const withdrawn=new Set(ids.slice(0,2));
 const noContest=matches.find(m=>withdrawn.has(m.player1Id!)&&withdrawn.has(m.player2Id!))!;
 expect(noContest).toMatchObject({status:'blocked',winnerId:null,score1:null});expect(noContest.blockedReason).toContain('no contest');
 await expect(reportScore(db,admin,{...score(noContest,'fake-forfeit'),outcome:'forfeit'})).rejects.toThrow('no contest');
 for(const m of matches.filter(m=>m.id!==noContest.id))await reportScore(db,admin,{...score(m,`finish-${m.id}`),outcome:withdrawn.has(m.player1Id!)||withdrawn.has(m.player2Id!)?'forfeit':'played',winnerId:withdrawn.has(m.player1Id!)?m.player2Id!:m.player1Id!});
 const pool=(await getPlan(db,planId))!.divisions[0]!.pools[0]!;
 await savePoolPlacements(db,planId,'upper',[{poolIndex:0,playerIdsInOrder:ids.slice(0,4),expectedMatchRevisions:pool.matchRevisions,expectedPlacementRevision:pool.placementRevision}]);
 const division=(await getPlan(db,planId))!.divisions[0]!;
 expect(division.championship.map(p=>p.playerId)).toEqual(ids.slice(2,4));expect(division.consolation).toBeNull();
});

it('invalidates confirmed placements when imported pool results change, including attached finals',async()=>{
 const [t]=await db.insert(tournaments).values({challongeSlug:'corrected-pools',name:'Pools'}).returning();
 await db.insert(eventPlanBrackets).values([{eventPlanId:planId,division:'upper',stage:'main',tournamentId:t!.id},{eventPlanId:planId,division:'upper',stage:'consolation',challongeSlug:'already-handed-off'}]);
 const [remote]=await db.insert(sets).values({tournamentId:t!.id,challongeMatchId:200,state:'complete',resultStage:'group',p1PlayerId:ids[0],p2PlayerId:ids[1],winner:1,scoresCsv:'2-0'}).returning();
 await ready();
 await db.insert(eventPlanPoolPlacements).values(ids.slice(0,4).map((id,i)=>({eventPlanId:planId,division:'upper' as const,poolIndex:0,playerId:id,place:i+1})));
 await prepare(db,planId);expect(await db.select().from(eventPlanPoolPlacements)).toHaveLength(4);
 await db.update(sets).set({winner:2,scoresCsv:'0-2'}).where(eq(sets.id,remote!.id));await prepare(db,planId);
 expect(await db.select().from(eventPlanPoolPlacements)).toHaveLength(0);
 expect((await getPlan(db,planId))!.divisions[0]!.championship).toHaveLength(0);
 expect((await db.select().from(eventPlanBrackets)).find(b=>b.stage==='consolation')).toMatchObject({externalState:'error'});
 expect((await db.select().from(eventMatches)).find(m=>m.sourceSetId===remote!.id)).toMatchObject({score1:0,score2:2,syncState:'synced'});
});
