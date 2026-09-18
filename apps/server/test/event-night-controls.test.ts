import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventAnnouncements, eventMatchAudit, eventMatches, eventOperators, eventPlanEntries, eventPlanBrackets, eventPlans, eventPoolSchedules, eventScoreReports, eventStations, playerCharacters, players, sets, tournaments, user, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { resetOperations } from '../src/event-operations/attendance';
import { configurePool, publishAnnouncement, updateLiveScore } from '../src/event-operations/controls';
import { prepare, reportScore, snapshot, updateMatch } from '../src/event-operations/service';
import { createTestDb } from './helpers/testDb';

let db: Db;
let close: () => Promise<void>;
let planId: string;
let ids: string[];
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const helper: SessionUser = { id: 'helper', role: 'user', name: 'Helper', email: 'helper@example.test' };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values([admin, helper]);
  ids = (await db.insert(players).values(Array.from({ length: 8 }, (_, i) => ({ canonicalName: `Private name ${i}`, displayName: `Alias${i}` }))).returning()).map(player => player.id);
  planId = (await db.insert(eventPlans).values({ name: 'Night controls', eventDate: new Date(), status: 'pools_ready' }).returning())[0]!.id;
  await db.insert(eventPlanEntries).values(ids.map((id, index) => ({ eventPlanId: planId, playerId: id, sourceLineNumber: index + 1, rawInput: 'Private input', cleanedName: 'Player', assignedDivision: index < 4 ? 'upper' as const : 'lower' as const, divisionSeed: index % 4 + 1 })));
  await prepare(db, planId);
});
afterEach(async () => close());
const allMatches = () => db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
const station = async (name: string) => (await db.insert(eventStations).values({ eventPlanId: planId, name }).returning())[0]!;

describe('live scores', () => {
  it('publishes 0-0 and ties while playing without recording a completed result, then finalises separately', async () => {
    const [match] = await allMatches();
    const desk = await station('Stage');
    const started = await updateMatch(db, admin, { matchId: match!.id, expectedRevision: 0, status: 'playing', stationId: desk.id });
    const initial = await updateLiveScore(db, admin, { matchId: match!.id, expectedRevision: started.revision, score1: 0, score2: 0 });
    const live = await updateLiveScore(db, admin, { matchId: match!.id, expectedRevision: initial.revision, score1: 1, score2: 1 });
    expect(live).toMatchObject({ score1: null, score2: null, liveScore1: 1, liveScore2: 1, winnerId: null, outcome: null, resultUpdatedAt: null, status: 'playing' });
    const view = await snapshot(db, planId, true);
    expect(view.matches.find(row => row.id === live.id)).toMatchObject({ score1: 1, score2: 1, winnerId: null, resultUpdatedAt: null });
    expect(view.stations[0]).toMatchObject({ status: 'occupied', currentMatchId: match!.id });
    expect(await db.select().from(eventScoreReports)).toHaveLength(0);
    expect(await db.select().from(sets)).toHaveLength(0);
    expect((await db.select().from(eventMatchAudit)).filter(row => row.action === 'live_score_updated')).toHaveLength(2);
    await reportScore(db, admin, { matchId: match!.id, expectedRevision: live.revision, requestId: 'finish', score1: 2, score2: 1, outcome: 'played' });
    const finished = (await snapshot(db, planId, true)).matches.find(row => row.id === live.id)!;
    expect(finished).toMatchObject({ score1: 2, score2: 1, liveScore1: null, liveScore2: null, status: 'complete', winnerId: match!.player1Id });
    expect(finished.resultUpdatedAt).not.toBeNull();
    expect((await snapshot(db, planId, true)).stations[0]!.status).toBe('free');
  });

  it('requires event TO access, current revision, playing state and an open event', async () => {
    const [match] = await allMatches();
    const input = { matchId: match!.id, expectedRevision: 0, score1: 0, score2: 0 };
    await expect(updateLiveScore(db, helper, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateLiveScore(db, admin, input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: helper.id });
    const started = await updateMatch(db, helper, { matchId: match!.id, expectedRevision: 0, status: 'playing' });
    const contenders = await Promise.allSettled([
      updateLiveScore(db, helper, { ...input, expectedRevision: started.revision, score1: 1 }),
      updateLiveScore(db, admin, { ...input, expectedRevision: started.revision, score2: 1 }),
    ]);
    expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(contenders.filter(result => result.status === 'rejected')).toHaveLength(1);
    await db.update(eventPlans).set({ status: 'complete' }).where(eq(eventPlans.id, planId));
    await expect(updateLiveScore(db, admin, { ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('pool waves and station allocation', () => {
  it('explains held pools, enforces allocated stations and assigns a free allocated station on start', async () => {
    const stage = await station('Stage');
    const side = await station('Side');
    const match = (await allMatches()).find(row => row.division === 'upper')!;
    const held = await configurePool(db, admin, { planId, division: 'upper', poolIndex: 0, active: false, stationIds: [stage.id], expectedRevision: 0 });
    expect((await snapshot(db, planId, true)).matches.find(row => row.id === match.id)!.availability.reasons).toContainEqual({ code: 'pool_held', message: 'This pool is scheduled for a later wave.' });
    await expect(updateMatch(db, admin, { matchId: match.id, expectedRevision: 0, status: 'playing', stationId: stage.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await configurePool(db, admin, { planId, division: 'upper', poolIndex: 0, active: true, stationIds: [stage.id], expectedRevision: held.revision });
    await expect(updateMatch(db, admin, { matchId: match.id, expectedRevision: 0, status: 'playing', stationId: side.id })).rejects.toThrow('not allocated');
    const started = await updateMatch(db, admin, { matchId: match.id, expectedRevision: 0, status: 'playing' });
    expect(started.stationId).toBe(stage.id);
    await expect(configurePool(db, admin, { planId, division: 'upper', poolIndex: 0, active: false, stationIds: [stage.id] })).rejects.toThrow('playing matches');
    await expect(configurePool(db, admin, { planId, division: 'upper', poolIndex: 0, active: true, stationIds: [side.id] })).rejects.toThrow('playing matches');
    const samePlayer = (await snapshot(db, planId, true)).matches.find(row => row.id !== match.id && [row.player1Id, row.player2Id].includes(match.player1Id))!;
    expect(samePlayer.availability.reasons.some(reason => reason.code === 'player_busy')).toBe(true);
  });

  it('explains occupied stations, prevents cross-event allocations and rejects stale schedule changes', async () => {
    const desk = await station('One setup');
    const matches = await allMatches();
    const upper = matches.find(row => row.division === 'upper')!;
    const lower = matches.find(row => row.division === 'lower')!;
    await updateMatch(db, admin, { matchId: lower.id, expectedRevision: 0, status: 'playing', stationId: desk.id });
    const schedule = await configurePool(db, admin, { planId, division: 'upper', poolIndex: 0, active: true, stationIds: [desk.id], expectedRevision: 0 });
    const availability = (await snapshot(db, planId, true)).matches.find(row => row.id === upper.id)!.availability;
    expect(availability).toMatchObject({ canStart: false, eligibleStationIds: [] });
    expect(availability.reasons.some(reason => reason.code === 'station_busy')).toBe(true);
    await expect(updateMatch(db, admin, { matchId: upper.id, expectedRevision: 0, status: 'playing' })).rejects.toThrow('occupied');
    await expect(configurePool(db, admin, { planId, division: 'upper', poolIndex: 0, active: false, stationIds: [], expectedRevision: schedule.revision - 1 })).rejects.toThrow('Another organiser');
    const [otherPlan] = await db.insert(eventPlans).values({ name: 'Another event', eventDate: new Date() }).returning();
    const [foreign] = await db.insert(eventStations).values({ eventPlanId: otherPlan!.id, name: 'Elsewhere' }).returning();
    await expect(configurePool(db, admin, { planId, division: 'upper', poolIndex: 0, active: true, stationIds: [foreign!.id] })).rejects.toThrow('belong to this event');
    expect(await db.select().from(eventPoolSchedules)).toHaveLength(1);
  });

  it('preserves unrestricted defaults for existing events', async () => {
    const [match] = await allMatches();
    const view = await snapshot(db, planId, true);
    expect(view.poolSchedules).toEqual([]);
    expect(view.matches.every(row => row.availability.canStart)).toBe(true);
    expect(await updateMatch(db, admin, { matchId: match!.id, expectedRevision: 0, status: 'playing' })).toMatchObject({ stationId: null, status: 'playing' });
  });
});

describe('public display additions', () => {
  it('expires timed announcements without hiding permanent announcements', async () => {
    const [timed] = await publishAnnouncement(db, admin, { planId, message: 'Pool B in two minutes', durationSeconds: 120 });
    await publishAnnouncement(db, admin, { planId, message: 'Welcome' });
    let view = await snapshot(db, planId, true);
    expect(view.announcements).toHaveLength(2);
    expect(view.announcements.find(row => row.id === timed!.id)!.expiresAt).toBeTypeOf('string');
    await db.update(eventAnnouncements).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(eventAnnouncements.id, timed!.id));
    view = await snapshot(db, planId, true);
    expect(view.announcements.map(row => row.message)).toEqual(['Welcome']);
    await expect(publishAnnouncement(db, helper, { planId, message: 'Not a TO' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns ordered character mains and aliases without private registry names', async () => {
    await db.insert(playerCharacters).values([{ playerId: ids[0]!, characterSlug: 'luigi', position: 1 }, { playerId: ids[0]!, characterSlug: 'mario', position: 0 }]);
    const view = await snapshot(db, planId, true);
    const match = view.matches.find(row => row.player1Id === ids[0])!;
    expect(match.player1Characters).toEqual(['mario', 'luigi']);
    expect(match.player2Characters).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('Private');
  });
});

it('clears pool schedules on an unplayed reset but retains paused live-score history',async()=>{
 await configurePool(db,admin,{planId,division:'upper',poolIndex:0,active:false,stationIds:[]});
 await resetOperations(db,admin,planId);expect(await db.select().from(eventPoolSchedules)).toHaveLength(0);
 await prepare(db,planId);const [match]=await allMatches();
 const started=await updateMatch(db,admin,{matchId:match!.id,expectedRevision:0,status:'playing'});
 const live=await updateLiveScore(db,admin,{matchId:match!.id,expectedRevision:started.revision,score1:1,score2:0});
 await updateMatch(db,admin,{matchId:match!.id,expectedRevision:live.revision,status:'ready'});
 await expect(resetOperations(db,admin,planId)).rejects.toMatchObject({code:'CONFLICT'});
});

it('accepts an official final after local live progress without treating live counts as a completed correction',async()=>{
 const match=(await allMatches()).find(row=>row.division==='upper')!;
 const started=await updateMatch(db,admin,{matchId:match.id,expectedRevision:0,status:'playing'});
 await updateLiveScore(db,admin,{matchId:match.id,expectedRevision:started.revision,score1:1,score2:1});
 const [tournament]=await db.insert(tournaments).values({challongeSlug:'live-final-refresh',name:'Upper'}).returning();
 await db.insert(eventPlanBrackets).values({eventPlanId:planId,division:'upper',stage:'main',tournamentId:tournament!.id});
 await db.insert(sets).values({tournamentId:tournament!.id,challongeMatchId:1,resultStage:'group',state:'complete',p1PlayerId:match.player1Id,p2PlayerId:match.player2Id,winner:1,scoresCsv:'2-1'});
 await prepare(db,planId);
 expect((await allMatches()).find(row=>row.id===match.id)).toMatchObject({status:'complete',score1:2,score2:1,liveScore1:null,liveScore2:null,syncState:'synced'});
});
