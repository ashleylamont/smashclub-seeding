import { isSinglePool } from '@smashclub/shared';
import type { buildRoundRobin } from '@smashclub/tournament-formats';
import { hasRecordedMatchEvidence, stableId, unconfirmedCall } from './facts';
import type { Match, TournamentState } from './schemas';

type Pool = TournamentState['pools'][number];
type Pairing = ReturnType<typeof buildRoundRobin>[number];

export function attendancePoolCandidates(state: TournamentState, division: Pool['division']) {
  return state.pools
    .filter(
      (pool) =>
        pool.division === division &&
        (isSinglePool(state.baseline?.structure) || pool.entrantIds.length < 5),
    )
    .sort((a, b) => a.entrantIds.length - b.entrantIds.length || a.index - b.index);
}

export function poolAttendanceBlocker(
  state: TournamentState,
  pool: Pool,
  reported: ReadonlySet<string>,
) {
  if (pool.order || pool.orderDecision || pool.qualifierRoster || pool.qualifierDecision)
    return 'qualification';
  const matches = state.matches.filter((match) => match.poolId === pool.id);
  const matchIds = new Set(matches.map((match) => match.id));
  const archived = (state.supersededPlayedSets ?? []).some(
    ({ match, sourcePoolMatchId }) =>
      matchIds.has(sourcePoolMatchId) ||
      [match.player1Id, match.player2Id].some((id) => id && pool.entrantIds.includes(id)),
  );
  if (archived || matches.some((match) => hasRecordedMatchEvidence(match, reported)))
    return 'evidence';
  const called = matches.filter((match) => match.status === 'playing' || match.calledAt != null);
  if (called.length)
    return called.every(unconfirmedCall)
      ? { kind: 'call' as const, matchIds: called.map(({ id }) => id) }
      : 'call_state';
  return null;
}

export function lastPoolRound(state: TournamentState, poolId: string) {
  return Math.max(
    0,
    ...state.matches.filter((match) => match.poolId === poolId).map((m) => m.round),
  );
}

export function poolMatch(pool: Pool, commandId: string, pairing: Pairing, round: number): Match {
  const { player1Id, player2Id, meeting, slot } = pairing;
  const id = stableId(`${commandId}:${pool.id}:${meeting}:${player1Id}:${player2Id}`);
  return {
    id,
    sourceKey: id,
    division: pool.division,
    stage: 'group',
    poolId: pool.id,
    bracketId: null,
    round,
    slot,
    label: `${pool.division} pool ${pool.index + 1}`,
    parent1Id: null,
    parent2Id: null,
    player1Id,
    player2Id,
    status: 'ready',
    outcome: null,
    score1: null,
    score2: null,
    winnerId: null,
    stationId: null,
    revision: 0,
    started: false,
    completedAt: null,
    automaticFromRevision: null,
    resultCommandId: null,
    liveScore1: null,
    liveScore2: null,
    progressRevision: 0,
    blockedReason: null,
  };
}
