import { buildRoundRobin } from '@smashclub/engine';
import { eq } from 'drizzle-orm';
import {
  eventMatches,
  eventPoolSchedules,
  eventStations,
  eventWithdrawals,
  eventPlans,
  type Db,
} from '@smashclub/db';

type Match = Pick<
  typeof eventMatches.$inferSelect,
  'id' | 'stage' | 'division' | 'poolIndex' | 'player1Id' | 'player2Id' | 'stationId' | 'status'
> &
  Partial<
    Pick<typeof eventMatches.$inferSelect, 'blockedReason' | 'nativeRound' | 'nativeSlot'>
  > & {
    player1MemberIds?: string[];
    player2MemberIds?: string[];
  };
export const queueMemberIds = (
  m: Pick<Match, 'player1Id' | 'player2Id' | 'player1MemberIds' | 'player2MemberIds'>,
) => [
  ...(m.player1MemberIds ?? (m.player1Id ? [m.player1Id] : [])),
  ...(m.player2MemberIds ?? (m.player2Id ? [m.player2Id] : [])),
];
type Station = Pick<typeof eventStations.$inferSelect, 'id'> &
  Partial<Pick<typeof eventStations.$inferSelect, 'name'>>;
type Schedule = Pick<
  typeof eventPoolSchedules.$inferSelect,
  'division' | 'poolIndex' | 'active' | 'stationIds'
>;
export const matchPoolKey = (m: Pick<Match, 'stage' | 'division' | 'poolIndex'>) =>
  m.stage === 'group' && m.poolIndex !== null ? `${m.division}:${m.poolIndex}` : null;
const scheduleKey = (s: Schedule) => `${s.division}:${s.poolIndex}`;
const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());

/** Finished pools release their banks without mutating the organiser's saved schedule. */
export function activePoolReservations(matches: readonly Match[], schedules: readonly Schedule[]) {
  return schedules.filter((schedule) => {
    if (!schedule.active) return false;
    const pool = matches.filter((match) => matchPoolKey(match) === scheduleKey(schedule));
    return (
      !pool.length ||
      !pool.every(
        (match) =>
          match.status === 'complete' ||
          match.blockedReason === 'Both players withdrawn: no contest; no winner or score recorded',
      )
    );
  });
}

/** Circle rounds depend on stable player IDs, never query order or match completion. */
export function buildStationQueues(
  matches: readonly Match[],
  stations: readonly Station[],
  schedules: readonly Schedule[],
  withdrawnIds: readonly string[] = [],
  eventOpen = true,
) {
  const ordered = [...matches].sort((a, b) => a.id.localeCompare(b.id));
  const keys = [
    ...new Set(ordered.map(matchPoolKey).filter((key): key is string => key !== null)),
  ].sort();
  const roundById = new Map<string, number>();
  const poolRounds = keys.map((poolKey) => {
    const pool = ordered.filter((m) => matchPoolKey(m) === poolKey);
    const ids = [
      ...new Set(
        pool.flatMap((m) => [m.player1Id, m.player2Id].filter((id): id is string => Boolean(id))),
      ),
    ].sort();
    const rounds: { round: number; matchIds: string[]; restingPlayerIds: string[] }[] = [];
    // Newly generated native draws carry their chosen rounds. Older/imported
    // draws retain the stable-ID circle order, using the same engine primitive.
    if (pool.every((m) => (m.nativeRound ?? 0) > 0)) {
      for (const round of [...new Set(pool.map((m) => m.nativeRound!))].sort((a, b) => a - b)) {
        const inRound = pool
          .filter((m) => m.nativeRound === round)
          .sort((a, b) => (a.nativeSlot ?? 0) - (b.nativeSlot ?? 0) || a.id.localeCompare(b.id));
        const playing = new Set(inRound.flatMap((m) => [m.player1Id, m.player2Id]));
        rounds.push({
          round,
          matchIds: inRound.map((m) => m.id),
          restingPlayerIds: ids.filter((id) => !playing.has(id)),
        });
        for (const m of inRound) roundById.set(m.id, round);
      }
    } else {
      for (const pairing of buildRoundRobin(ids)) {
        let entry = rounds.find((r) => r.round === pairing.round);
        if (!entry) {
          entry = { round: pairing.round, matchIds: [], restingPlayerIds: [] };
          rounds.push(entry);
        }
        const found = pool.filter(
          (m) =>
            m.player1Id &&
            m.player2Id &&
            pairKey(m.player1Id, m.player2Id) === pairKey(pairing.player1Id, pairing.player2Id),
        );
        for (const match of found) {
          entry.matchIds.push(match.id);
          roundById.set(match.id, pairing.round);
        }
      }
      for (const round of rounds) {
        const playing = new Set(
          pool
            .filter((m) => round.matchIds.includes(m.id))
            .flatMap((m) => [m.player1Id, m.player2Id]),
        );
        round.restingPlayerIds = ids.filter((id) => !playing.has(id));
        round.matchIds.sort();
      }
    }
    return { poolKey, rounds };
  });
  const reservations = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const schedule of activePoolReservations(matches, schedules).sort((a, b) =>
    scheduleKey(a).localeCompare(scheduleKey(b)),
  ))
    for (const id of schedule.stationIds) {
      if (reservations.has(id)) conflicts.add(id);
      reservations.set(id, scheduleKey(schedule));
    }
  const stationQueues = [...stations]
    .sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }) ||
        a.id.localeCompare(b.id),
    )
    .map((station) => ({
      stationId: station.id,
      poolKey: conflicts.has(station.id) ? null : (reservations.get(station.id) ?? null),
      currentMatchId:
        ordered.find((m) => m.status === 'playing' && m.stationId === station.id)?.id ?? null,
      nextMatchId: null as string | null,
      upcoming: [] as { matchId: string; round: number }[],
      waitingReason: null as string | null,
    }));
  const candidates = ordered.filter(
    (m) =>
      eventOpen &&
      m.status === 'ready' &&
      m.player1Id &&
      m.player2Id &&
      !withdrawnIds.includes(m.player1Id) &&
      !withdrawnIds.includes(m.player2Id) &&
      !schedules.some((s) => scheduleKey(s) === matchPoolKey(m) && !s.active),
  );
  const eligible = (m: Match, stationId: string) => {
    const key = matchPoolKey(m),
      schedule = schedules.find((s) => scheduleKey(s) === key),
      owner = reservations.get(stationId);
    return (
      !conflicts.has(stationId) &&
      (!m.stationId || m.stationId === stationId) &&
      (!owner || owner === key) &&
      (!schedule?.stationIds.length || schedule.stationIds.includes(stationId))
    );
  };
  const used = new Set<string>();
  let previousPlayers = new Set(
    ordered.filter((m) => m.status === 'playing').flatMap(queueMemberIds),
  );
  for (let wave = 0; wave <= candidates.length; wave++) {
    const busy = new Set(wave === 0 ? previousPlayers : []);
    let allocated = 0;
    for (const queue of stationQueues) {
      if (wave === 0 && queue.currentMatchId) continue;
      const choices = candidates.filter(
        (m) =>
          !used.has(m.id) &&
          eligible(m, queue.stationId) &&
          !queueMemberIds(m).some((id) => busy.has(id)),
      );
      choices.sort(
        (a, b) =>
          (roundById.get(a.id) ?? 0) - (roundById.get(b.id) ?? 0) ||
          Number(queueMemberIds(a).some((id) => previousPlayers.has(id))) -
            Number(queueMemberIds(b).some((id) => previousPlayers.has(id))) ||
          a.id.localeCompare(b.id),
      );
      const match = choices[0];
      if (!match) continue;
      used.add(match.id);
      for (const id of queueMemberIds(match)) busy.add(id);
      allocated++;
      if (wave === 0) queue.nextMatchId = match.id;
      else queue.upcoming.push({ matchId: match.id, round: roundById.get(match.id) ?? 0 });
    }
    if (wave > 0 && !allocated) break;
    previousPlayers = busy;
  }
  for (const queue of stationQueues)
    if (!queue.currentMatchId && !queue.nextMatchId)
      queue.waitingReason = !eventOpen
        ? 'Event closed'
        : conflicts.has(queue.stationId)
          ? 'Conflicting active pool reservations; an organiser must review station allocation'
          : queue.poolKey
            ? 'Waiting for available pool opponents'
            : 'No available match';
  return { stationQueues, poolRounds };
}

/** Read-only projection; callers making decisions must already hold the event lock. */
export async function loadStationQueues(db: Db, planId: string) {
  const [matches, stations, schedules, withdrawals, plans] = await Promise.all([
    db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId)),
    db.select().from(eventStations).where(eq(eventStations.eventPlanId, planId)),
    db.select().from(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId, planId)),
    db.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, planId)),
    db.select().from(eventPlans).where(eq(eventPlans.id, planId)),
  ]);
  return buildStationQueues(
    matches,
    stations,
    schedules,
    withdrawals.map((w) => w.playerId),
    plans[0] !== undefined && !['complete', 'cancelled'].includes(plans[0].status),
  );
}
