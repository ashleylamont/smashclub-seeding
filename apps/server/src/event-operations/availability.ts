import type { eventMatches, eventPoolSchedules, eventStations } from '@smashclub/db';

type Match = typeof eventMatches.$inferSelect;
type Station = typeof eventStations.$inferSelect;
type Schedule = typeof eventPoolSchedules.$inferSelect;
export interface MatchAvailability {
  canStart: boolean;
  reasons: Array<{ code: string; message: string }>;
  eligibleStationIds: string[];
}

/** Same policy drives the spectator explanation and the server-side start gate. */
export function matchAvailability(
  match: Match,
  matches: readonly Match[],
  stations: readonly Station[],
  schedules: readonly Schedule[],
  allowCurrentPlaying = false,
  eventOpen = true,
): MatchAvailability {
  const reasons: MatchAvailability['reasons'] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });
  const schedule = match.stage === 'group' ? schedules.find(pool => pool.division === match.division && pool.poolIndex === match.poolIndex) : undefined;
  const permitted = schedule?.stationIds.length ? schedule.stationIds : stations.map(station => station.id);
  const otherPlaying = matches.filter(other => other.status === 'playing' && other.id !== match.id);
  const eligibleStationIds = stations.filter(station => permitted.includes(station.id) && !otherPlaying.some(other => other.stationId === station.id)).map(station => station.id);

  if (!eventOpen) add('event_closed', 'This event is closed.');
  if (match.status === 'complete') add('complete', 'This match has finished.');
  if (match.status === 'playing' && !allowCurrentPlaying) add('playing', 'This match is already playing.');
  if (match.status === 'blocked') add('blocked', match.blockedReason ?? 'An organiser has held this match.');
  if (!match.player1Id || !match.player2Id) add('participants_unknown', 'Waiting for both players to be confirmed.');
  if (schedule && !schedule.active) add('pool_held', 'This pool is scheduled for a later wave.');
  const busy = otherPlaying.find(other => [other.player1Id, other.player2Id].some(id => id && [match.player1Id, match.player2Id].includes(id)));
  if (busy) add('player_busy', `A player is already playing in ${busy.label}.`);
  if (match.stationId) {
    const station = stations.find(candidate => candidate.id === match.stationId);
    if (!station || !permitted.includes(match.stationId)) add('station_not_allocated', 'This station is not allocated to the pool.');
    else if (otherPlaying.some(other => other.stationId === match.stationId)) add('station_busy', `${station.name} is occupied by another match.`);
  } else if (stations.length && !eligibleStationIds.length) {
    add('station_busy', schedule?.stationIds.length ? 'All stations allocated to this pool are occupied.' : 'All stations are occupied.');
  }
  return { canStart: reasons.length === 0, reasons, eligibleStationIds };
}

export function stationAvailability(station: Station, matches: readonly Match[]) {
  const current = matches.find(match => match.status === 'playing' && match.stationId === station.id);
  return { ...station, status: current ? 'occupied' as const : 'free' as const, currentMatchId: current?.id ?? null };
}
