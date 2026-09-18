import { eq } from 'drizzle-orm';
import { eventMatches, eventPoolSchedules, eventStations, eventWithdrawals, eventPlans, type Db } from '@smashclub/db';

type Match = Pick<typeof eventMatches.$inferSelect, 'id'|'stage'|'division'|'poolIndex'|'player1Id'|'player2Id'|'stationId'|'status'> & Partial<Pick<typeof eventMatches.$inferSelect,'blockedReason'>>;
type Station = Pick<typeof eventStations.$inferSelect, 'id'> & Partial<Pick<typeof eventStations.$inferSelect, 'name'>>;
type Schedule = Pick<typeof eventPoolSchedules.$inferSelect, 'division'|'poolIndex'|'active'|'stationIds'>;
export const matchPoolKey = (m: Pick<Match,'stage'|'division'|'poolIndex'>) => m.stage === 'group' && m.poolIndex !== null ? `${m.division}:${m.poolIndex}` : null;
const scheduleKey = (s: Schedule) => `${s.division}:${s.poolIndex}`;
const pairKey = (a: string, b: string) => JSON.stringify([a,b].sort());

/** Finished pools release their banks without mutating the organiser's saved schedule. */
export function activePoolReservations(matches: readonly Match[], schedules: readonly Schedule[]) {
  return schedules.filter(schedule => {
    if (!schedule.active) return false;
    const pool = matches.filter(match => matchPoolKey(match) === scheduleKey(schedule));
    return !pool.length || !pool.every(match => match.status === 'complete' || match.blockedReason === 'Both players withdrawn: no contest; no winner or score recorded');
  });
}

/** Circle rounds depend on stable player IDs, never query order or match completion. */
export function buildStationQueues(matches: readonly Match[], stations: readonly Station[], schedules: readonly Schedule[], withdrawnIds: readonly string[] = [], eventOpen = true) {
  const ordered = [...matches].sort((a,b)=>a.id.localeCompare(b.id));
  const keys = [...new Set(ordered.map(matchPoolKey).filter((key):key is string=>key !== null))].sort();
  const roundById = new Map<string,number>();
  const poolRounds = keys.map(poolKey => {
    const pool = ordered.filter(m=>matchPoolKey(m)===poolKey);
    const ids = [...new Set(pool.flatMap(m=>[m.player1Id,m.player2Id].filter((id):id is string=>!!id)))].sort();
    const rotation: Array<string|null> = [...ids];
    if(rotation.length % 2) rotation.push(null);
    const rounds: Array<{round:number;matchIds:string[];restingPlayerIds:string[]}> = [];
    for(let round=1;round<rotation.length;round++) {
      const matchIds:string[]=[]; const restingPlayerIds:string[]=[];
      for(let i=0;i<rotation.length/2;i++) {
        const a=rotation[i], b=rotation[rotation.length-1-i];
        if(!a || !b) { if(a??b) restingPlayerIds.push((a??b)!); continue; }
        const found=pool.filter(m=>m.player1Id&&m.player2Id&&pairKey(m.player1Id,m.player2Id)===pairKey(a,b));
        for(const match of found) {matchIds.push(match.id);roundById.set(match.id,round);}
      }
      rounds.push({round,matchIds:matchIds.sort(),restingPlayerIds});
      rotation.splice(1,0,rotation.pop()!);
    }
    return {poolKey,rounds};
  });
  const reservations = new Map<string,string>();
  for(const schedule of activePoolReservations(matches,schedules).sort((a,b)=>scheduleKey(a).localeCompare(scheduleKey(b)))) for(const id of schedule.stationIds) reservations.set(id,scheduleKey(schedule));
  const stationQueues = [...stations].sort((a,b)=>(a.name??'').localeCompare(b.name??'',undefined,{numeric:true})||a.id.localeCompare(b.id)).map(station=>({stationId:station.id,poolKey:reservations.get(station.id)??null,currentMatchId:ordered.find(m=>m.status==='playing'&&m.stationId===station.id)?.id??null,nextMatchId:null as string|null,upcoming:[] as Array<{matchId:string;round:number}>,waitingReason:null as string|null}));
  const candidates=ordered.filter(m=>eventOpen && m.status==='ready' && m.player1Id&&m.player2Id&&!withdrawnIds.includes(m.player1Id)&&!withdrawnIds.includes(m.player2Id)&&!schedules.some(s=>scheduleKey(s)===matchPoolKey(m)&&!s.active));
  const eligible = (m:Match, stationId:string) => {
    const key=matchPoolKey(m), schedule=schedules.find(s=>scheduleKey(s)===key), owner=reservations.get(stationId);
    return (!m.stationId||m.stationId===stationId)&&(!owner||owner===key)&&(!schedule?.stationIds.length||schedule.stationIds.includes(stationId));
  };
  const used=new Set<string>();
  let previousPlayers=new Set(ordered.filter(m=>m.status==='playing').flatMap(m=>[m.player1Id,m.player2Id].filter((id):id is string=>!!id)));
  for(let wave=0;wave<=candidates.length;wave++) {
    const busy=new Set(wave===0?previousPlayers:[]);
    let allocated=0;
    for(const queue of stationQueues) {
      if(wave===0&&queue.currentMatchId) continue;
      const choices=candidates.filter(m=>!used.has(m.id)&&eligible(m,queue.stationId)&&!busy.has(m.player1Id!)&&!busy.has(m.player2Id!));
      choices.sort((a,b)=>(roundById.get(a.id)??0)-(roundById.get(b.id)??0) || Number(previousPlayers.has(a.player1Id!)||previousPlayers.has(a.player2Id!))-Number(previousPlayers.has(b.player1Id!)||previousPlayers.has(b.player2Id!)) || a.id.localeCompare(b.id));
      const match=choices[0]; if(!match) continue;
      used.add(match.id);busy.add(match.player1Id!);busy.add(match.player2Id!);allocated++;
      if(wave===0) queue.nextMatchId=match.id;
      else queue.upcoming.push({matchId:match.id,round:roundById.get(match.id)??0});
    }
    if(wave>0&&!allocated) break;
    previousPlayers=busy;
  }
  for(const queue of stationQueues) if(!queue.currentMatchId&&!queue.nextMatchId) queue.waitingReason=!eventOpen?'Event closed':queue.poolKey?'Waiting for available pool opponents':'No available match';
  return {stationQueues,poolRounds};
}

/** Read-only projection; callers making decisions must already hold the event lock. */
export async function loadStationQueues(db:Db,planId:string) {
  const [matches,stations,schedules,withdrawals,plans]=await Promise.all([
    db.select().from(eventMatches).where(eq(eventMatches.eventPlanId,planId)),db.select().from(eventStations).where(eq(eventStations.eventPlanId,planId)),db.select().from(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId,planId)),db.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId,planId)),db.select().from(eventPlans).where(eq(eventPlans.id,planId)),
  ]);
  return buildStationQueues(matches,stations,schedules,withdrawals.map(w=>w.playerId),!!plans[0]&&!['complete','cancelled'].includes(plans[0].status));
}
