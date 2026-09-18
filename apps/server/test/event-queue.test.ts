import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches,eventPlans,eventPlanEntries,eventPoolSchedules,eventStations,players,user,type Db } from '@smashclub/db';
import { buildStationQueues,loadStationQueues } from '../src/event-operations/queue';
import { applyAttendance,previewAttendance } from '../src/event-operations/attendance';
import { configurePool,configurePools } from '../src/event-operations/controls';
import { prepare,updateMatch,reportScore,snapshot } from '../src/event-operations/service';
import { createTestDb } from './helpers/testDb';
import type { SessionUser } from '../src/auth';
type Match=Parameters<typeof buildStationQueues>[0][number];
const pool=(size:number,division:'upper'|'lower'='upper'):Match[]=>Array.from({length:size},(_,i)=>Array.from({length:size-i-1},(_,j)=>({id:`${division}-${i}-${i+j+1}`,stage:'group' as const,division,poolIndex:0,player1Id:`${division}${i}`,player2Id:`${division}${i+j+1}`,stationId:null,status:'ready' as const}))).flat();
const stations=[{id:'a'},{id:'b'}];
const schedule={division:'upper' as const,poolIndex:0,active:true,stationIds:['a','b']};
describe('pure station queue',()=>{
  it.each([3,4,5])('makes stable %i-player rounds with honest rests and no duplicate pair',size=>{
    const matches=pool(size); const result=buildStationQueues(matches,stations,[schedule]);
    expect(buildStationQueues([...matches].reverse(),[...stations].reverse(),[schedule])).toEqual(result);
    const rounds=result.poolRounds[0]!.rounds;
    expect(rounds).toHaveLength(size%2?size:size-1);
    expect(rounds.flatMap(r=>r.matchIds).sort()).toEqual(matches.map(m=>m.id).sort());
    for(const round of rounds){
      expect(round.restingPlayerIds).toHaveLength(size%2);
      const active=round.matchIds.flatMap(id=>{const m=matches.find(m=>m.id===id)!;return [m.player1Id,m.player2Id];});
      expect(new Set(active).size).toBe(active.length);
      expect(active.some(id=>round.restingPlayerIds.includes(id!))).toBe(false);
    }
    const queued=result.stationQueues.flatMap(q=>[q.nextMatchId,...q.upcoming.map(m=>m.matchId)].filter(Boolean));
    expect(new Set(queued).size).toBe(matches.length);
  });
  it('fills two stations for four-player rounds and advances after completion',()=>{
    const matches=pool(4);const first=buildStationQueues(matches,stations,[schedule]);
    const next=first.stationQueues.map(q=>q.nextMatchId!);expect(next.filter(Boolean)).toHaveLength(2);
    for(const m of matches)if(next.includes(m.id))m.status='complete';
    const second=buildStationQueues(matches,stations,[schedule]);
    expect(second.stationQueues.every(q=>q.nextMatchId&&!next.includes(q.nextMatchId))).toBe(true);
    expect(second.stationQueues.flatMap(q=>q.upcoming).some(m=>next.includes(m.matchId))).toBe(false);
  });
  it('keeps independent banks exclusive and held pools out of forecasts',()=>{
    const matches=[...pool(4),...pool(4,'lower')];
    const schedules=[{...schedule,stationIds:['a']},{division:'lower' as const,poolIndex:0,active:true,stationIds:['b']}];
    const result=buildStationQueues(matches,stations,schedules);
    expect(result.stationQueues[0]!.nextMatchId).toMatch(/^upper/);expect(result.stationQueues[1]!.nextMatchId).toMatch(/^lower/);
    schedules[1]!.active=false;
    const held=buildStationQueues(matches,stations,schedules);
    expect(held.stationQueues[1]!.nextMatchId).toBeNull();expect(held.stationQueues[1]!.upcoming).toEqual([]);
  });
  it('releases only completed or explicit no-contest banks, never merely blocked pools',()=>{
    const matches=pool(3);matches.forEach(m=>m.status='complete');
    matches[0]!.status='blocked';
    expect(buildStationQueues(matches,stations,[schedule]).stationQueues[0]!.poolKey).toBe('upper:0');
    matches[0]!.blockedReason='Both players withdrawn: no contest; no winner or score recorded';
    expect(buildStationQueues(matches,stations,[schedule]).stationQueues.every(q=>q.poolKey===null)).toBe(true);
  });
  it('never advertises matches on a legacy conflicting bank',()=>{
    const matches=[...pool(4),...pool(4,'lower')];
    const projection=buildStationQueues(matches,stations,[schedule,{division:'lower',poolIndex:0,active:true,stationIds:['a']}]);
    expect(projection.stationQueues[0]).toMatchObject({poolKey:null,nextMatchId:null,upcoming:[]});
    expect(projection.stationQueues[0]!.waitingReason).toMatch(/Conflicting/);
    expect(projection.stationQueues[1]!.nextMatchId).toMatch(/^upper/);
  });
  it('honors pins, globally busy players, withdrawals and closed events',()=>{
    const matches=pool(4);matches[0]!.stationId='b';
    const busy:Match={id:'manual',division:'lower',stage:'main',poolIndex:null,player1Id:'upper0',player2Id:'guest',stationId:'a',status:'playing'};
    const result=buildStationQueues([...matches,busy],stations,[schedule]);
    expect(result.stationQueues[0]!.currentMatchId).toBe('manual');expect(result.stationQueues[0]!.nextMatchId).toBeNull();
    const next=matches.find(m=>m.id===result.stationQueues[1]!.nextMatchId)!;expect([next.player1Id,next.player2Id]).not.toContain('upper0');
    const clean=buildStationQueues(matches,stations,[schedule],['upper0']);
    for(const q of clean.stationQueues)for(const id of [q.nextMatchId,...q.upcoming.map(m=>m.matchId)].filter(Boolean)){const m=matches.find(m=>m.id===id)!;expect([m.player1Id,m.player2Id]).not.toContain('upper0');}
    const pinned=buildStationQueues(matches,stations,[schedule]);expect(pinned.stationQueues[0]!.nextMatchId).not.toBe(matches[0]!.id);expect(pinned.stationQueues[0]!.upcoming.some(m=>m.matchId===matches[0]!.id)).toBe(false);
    const closed=buildStationQueues(matches,stations,[schedule],[],false);expect(closed.stationQueues.every(q=>!q.nextMatchId&&!q.upcoming.length)).toBe(true);
  });
});

let db:Db,close:()=>Promise<void>,planId:string;
const admin:SessionUser={id:'admin',role:'admin',name:'TO',email:'to@example.test'};
describe('station bank integration',()=>{
  beforeEach(async()=>{
    ({db,close}=await createTestDb());await db.insert(user).values(admin);
    const ids=(await db.insert(players).values(Array.from({length:8},(_,i)=>({canonicalName:`Player ${i}`}))).returning()).map(p=>p.id);
    planId=(await db.insert(eventPlans).values({name:'Queues',eventDate:new Date(),status:'pools_ready',bracketMode:'native'}).returning())[0]!.id;
    await db.insert(eventPlanEntries).values(ids.map((playerId,i)=>({eventPlanId:planId,playerId,sourceLineNumber:i+1,rawInput:'name',cleanedName:'name',assignedDivision:i<4?'upper' as const:'lower' as const,divisionSeed:i%4+1})));
    await prepare(db,planId);
  });
  afterEach(async()=>close());
  const station=async()=> (await db.insert(eventStations).values({eventPlanId:planId,name:'Desk'}).returning())[0]!;
  it('atomically releases a bank and starts the next wave; stale batches roll back',async()=>{
    const desk=await station();const upper={division:'upper' as const,poolIndex:0,active:true,stationIds:[desk.id],expectedRevision:0,selfRun:true,autoAcceptScores:true};
    await configurePool(db,admin,{planId,...upper});
    await expect(configurePool(db,admin,{planId,...upper,division:'lower'})).rejects.toThrow(/same station/);
    await configurePools(db,admin,{planId,pools:[{...upper,active:false,expectedRevision:1},{...upper,division:'lower'}]});
    const rows=await db.select().from(eventPoolSchedules);expect(rows.find(p=>p.division==='upper')).toMatchObject({active:false,selfRun:true,autoAcceptScores:true,revision:2});
    await expect(configurePools(db,admin,{planId,pools:[{...upper,expectedRevision:2},{...upper,division:'lower',active:false,expectedRevision:0}]})).rejects.toThrow(/Another organiser/);
    expect(await db.select().from(eventPoolSchedules)).toEqual(rows);
    const projection=await loadStationQueues(db,planId);expect(projection.stationQueues[0]!.poolKey).toBe('lower:0');
    const state=await snapshot(db,planId,true);expect(state.stationQueues).toEqual(projection.stationQueues);
    expect(await db.select().from(eventPoolSchedules)).toEqual(rows);
  });
  it('protects reserved banks from unallocated matches and playing matches from reassignment',async()=>{
    const desk=await station();await configurePool(db,admin,{planId,division:'upper',poolIndex:0,active:true,stationIds:[desk.id]});
    const matches=await db.select().from(eventMatches);const lower=matches.find(m=>m.division==='lower')!;
    await expect(updateMatch(db,admin,{matchId:lower.id,expectedRevision:0,status:'playing',stationId:desk.id})).rejects.toThrow(/not allocated/);
    const next=(await loadStationQueues(db,planId)).stationQueues[0]!.nextMatchId!;
    const started=await updateMatch(db,admin,{matchId:next,expectedRevision:0,status:'playing',stationId:desk.id});
    await expect(configurePools(db,admin,{planId,pools:[{division:'upper',poolIndex:0,active:false,stationIds:[desk.id],expectedRevision:1},{division:'lower',poolIndex:0,active:true,stationIds:[desk.id],expectedRevision:0}]})).rejects.toThrow(/playing matches/);
    await reportScore(db,admin,{matchId:next,expectedRevision:started.revision,requestId:'finish',score1:2,score2:0,outcome:'played'});
    expect((await loadStationQueues(db,planId)).stationQueues[0]!.nextMatchId).not.toBe(next);
    await db.update(eventPlans).set({status:'complete'}).where(eq(eventPlans.id,planId));expect((await loadStationQueues(db,planId)).stationQueues[0]!.nextMatchId).toBeNull();
  });
  it('releases completed pool banks for finals and permits allocating a later pool',async()=>{
    const desk=await station();
    await configurePool(db,admin,{planId,division:'upper',poolIndex:0,active:true,stationIds:[desk.id]});
    const matches=await db.select().from(eventMatches);
    for(const match of matches.filter(m=>m.division==='upper'))await reportScore(db,admin,{matchId:match.id,expectedRevision:match.revision,requestId:match.id,score1:2,score2:0,outcome:'played'});
    await configurePool(db,admin,{planId,division:'lower',poolIndex:0,active:true,stationIds:[desk.id]});
    for(const match of matches.filter(m=>m.division==='lower'))await reportScore(db,admin,{matchId:match.id,expectedRevision:match.revision,requestId:match.id,score1:2,score2:0,outcome:'played'});
    const upper=matches.find(m=>m.division==='upper')!;
    const [final]=await db.insert(eventMatches).values({eventPlanId:planId,sourceKey:'final-test',division:'upper',stage:'main',label:'Championship',player1Id:upper.player1Id,player2Id:upper.player2Id,status:'ready'}).returning();
    const projection=await loadStationQueues(db,planId);expect(projection.stationQueues[0]).toMatchObject({poolKey:null,nextMatchId:final!.id});
    expect((await snapshot(db,planId,true)).matches.find(m=>m.id===final!.id)!.availability.canStart).toBe(true);
    expect((await updateMatch(db,admin,{matchId:final!.id,expectedRevision:0,status:'playing',stationId:desk.id})).stationId).toBe(desk.id);
    expect((await db.select().from(eventPoolSchedules)).every(s=>s.active)).toBe(true);
  });
  it('holds a reopened completed pool without reclaiming the next wave bank',async()=>{
    const desk=await station();
    await configurePool(db,admin,{planId,division:'upper',poolIndex:0,active:true,stationIds:[desk.id],selfRun:true});
    const upper=(await db.select().from(eventMatches)).filter(m=>m.division==='upper');
    for(const match of upper)await reportScore(db,admin,{matchId:match.id,expectedRevision:0,requestId:match.id,score1:2,score2:0,outcome:'played'});
    await configurePool(db,admin,{planId,division:'lower',poolIndex:0,active:true,stationIds:[desk.id]});
    const [late]=await db.insert(players).values({canonicalName:'Late arrival'}).returning();
    const input={planId,action:'add' as const,playerId:late!.id,division:'upper' as const,poolIndex:0};
    const stale=await previewAttendance(db,input);expect(stale.warnings.join(' ')).toMatch(/reopen on hold/);
    await configurePool(db,admin,{planId,division:'lower',poolIndex:0,active:true,stationIds:[desk.id],selfRun:true,expectedRevision:1});
    await expect(applyAttendance(db,admin,{...input,revisionToken:stale.revisionToken})).rejects.toThrow(/changed since/);
    const preview=await previewAttendance(db,input);await applyAttendance(db,admin,{...input,revisionToken:preview.revisionToken});
    const schedules=await db.select().from(eventPoolSchedules);expect(schedules.find(s=>s.division==='upper')).toMatchObject({active:false,revision:2,selfRun:true});
    expect((await loadStationQueues(db,planId)).stationQueues[0]!.poolKey).toBe('lower:0');
    const view=await snapshot(db,planId,true);expect(view.matches.filter(m=>m.division==='upper'&&m.status==='ready').every(m=>m.availability.reasons.some(r=>r.code==='pool_held'))).toBe(true);
    expect(view.matches.filter(m=>upper.some(before=>before.id===m.id)).every(m=>m.status==='complete')).toBe(true);
  });
  it('leaves an ongoing pool allocation active when adding a late entrant',async()=>{
    const desk=await station();await configurePool(db,admin,{planId,division:'upper',poolIndex:0,active:true,stationIds:[desk.id]});
    const [late]=await db.insert(players).values({canonicalName:'Ongoing arrival'}).returning();
    const input={planId,action:'add' as const,playerId:late!.id,division:'upper' as const,poolIndex:0};
    const preview=await previewAttendance(db,input);expect(preview.holdReopenedPool).toBe(false);
    await applyAttendance(db,admin,{...input,revisionToken:preview.revisionToken});
    expect((await db.select().from(eventPoolSchedules))[0]).toMatchObject({active:true,revision:1});
  });
  it('requires native mode and a station for self-running pools and preserves omitted policy',async()=>{
    const desk=await station();const input={planId,division:'upper' as const,poolIndex:0,active:true,stationIds:[desk.id]};
    await expect(configurePool(db,admin,{...input,stationIds:[],selfRun:true})).rejects.toThrow(/allocated station/);
    await db.update(eventPlans).set({bracketMode:'challonge'}).where(eq(eventPlans.id,planId));await expect(configurePool(db,admin,{...input,selfRun:true})).rejects.toThrow(/native event/);
    await db.update(eventPlans).set({bracketMode:'native'}).where(eq(eventPlans.id,planId));await configurePool(db,admin,{...input,selfRun:true,autoAcceptScores:true});
    expect(await configurePool(db,admin,{...input,active:false,expectedRevision:1})).toMatchObject({selfRun:true,autoAcceptScores:true});
  });
});
