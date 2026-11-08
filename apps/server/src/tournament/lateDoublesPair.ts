import { isKnockout } from '@smashclub/shared';
import { buildRoundRobin, poolLabel, selectFormatFinalists } from '@smashclub/tournament-formats';
import { sharedDispatch } from './dispatch';
import { advance } from './brackets';
import { memberIds } from './entrants';
import { hash, hasRecordedMatchEvidence, requireFact, stableId, unconfirmedCall } from './facts';
import { attendancePoolCandidates, lastPoolRound, poolMatch } from './poolAttendance';
import { qualifierFieldFrozen } from './qualifiers';
import { eligibleQualifierRoster } from './rollingFinals';
import type { CommandEnvelope, TournamentCommand, TournamentState } from './schemas';

type Command = Extract<TournamentCommand, { kind: 'addLateDoublesPair' }>;
export type LateDoublesPair = Omit<Command, 'kind' | 'revisionToken'>;
type Pool = TournamentState['pools'][number];

function poolIssue(state: TournamentState, pool: Pool, reported: ReadonlySet<string>) {
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

function prospectiveFinals(state: TournamentState, pool: Pool) {
  const structure = state.baseline?.structure;
  const options = state.baseline?.structureOptions;
  if (!structure || structure === 'round_robin') return null;

  const eligible = state.pools
    .filter((item) => item.division === pool.division)
    .flatMap((item) =>
      eligibleQualifierRoster(state, item).map((playerId, index) => ({
        playerId,
        poolIndex: item.index,
        place: index + 1,
      })),
    );
  const withNewPair = [
    ...eligible,
    {
      playerId: 'late-pair-preview',
      poolIndex: pool.index,
      place: eligibleQualifierRoster(state, pool).length + 1,
    },
  ];
  return {
    championship: {
      before: selectFormatFinalists(structure, eligible, 'main', options).length,
      after: selectFormatFinalists(structure, withNewPair, 'main', options).length,
    },
    consolation: {
      before: selectFormatFinalists(structure, eligible, 'consolation', options).length,
      after: selectFormatFinalists(structure, withNewPair, 'consolation', options).length,
    },
  };
}

export function reviewLateDoublesPair(state: TournamentState, input: LateDoublesPair) {
  const { division, memberPlayerIds, identity, reason } = input;
  const { competitionFormat, structure, structureOptions } = state.baseline ?? {};
  const issues: string[] = [];
  if (competitionFormat !== 'doubles' || isKnockout(structure))
    issues.push('Late pairs can join native doubles pool events only.');
  if (state.lifecycle !== 'locked' && state.lifecycle !== 'unlocked')
    issues.push('Late pairs require an open soft-locked draw.');
  if (memberPlayerIds[0] === memberPlayerIds[1]) issues.push('Choose two different players.');
  if (!identity) issues.push('Both players must be active and registered.');
  const identities = new Set([...memberPlayerIds, ...(identity?.memberAliases ?? [])]);
  if (state.entrants.some((entrant) => memberIds(entrant).some((id) => identities.has(id))))
    issues.push('One or both players already have an entry in this event.');

  const frozen = qualifierFieldFrozen(state, division);
  if (frozen) issues.push('Finals already use this division’s pool field.');
  const reported = new Set(state.reports.map((report) => report.matchId));
  const candidates = attendancePoolCandidates(state, division).map((pool) => ({
    pool,
    issue: poolIssue(state, pool, reported),
  }));
  const pool = frozen ? undefined : candidates.find((item) => item.issue === null)?.pool;
  const calledPool =
    !pool && !frozen
      ? candidates.find(({ issue }) => typeof issue === 'object' && issue?.kind === 'call')
      : undefined;
  const callBlocker = calledPool?.issue;
  const returnCallMatchIds =
    !issues.length && callBlocker && typeof callBlocker === 'object' ? callBlocker.matchIds : [];
  if (!pool && !frozen) {
    if (!state.pools.some((item) => item.division === division))
      issues.push('There is no pool in the selected division.');
    else if (!candidates.length) issues.push('Every pool in this division is full.');
    else if (calledPool)
      issues.push(
        `Return the untaken calls in Pool ${poolLabel(calledPool.pool.index)}, then review again.`,
      );
    else
      issues.push('Pools with room have calls, recorded play, reports or confirmed qualification.');
  }
  const meetings = structureOptions?.roundRobinMeetings ?? 1;
  const assignedTeams = pool?.entrantIds.length ?? 0;
  const addedMatches = assignedTeams * meetings;
  const pendingForfeits = pool
    ? (assignedTeams - eligibleQualifierRoster(state, pool).length) * meetings
    : 0;
  const previousMatches = pool ? state.matches.filter((match) => match.poolId === pool.id) : [];
  const finals = pool ? prospectiveFinals(state, pool) : null;
  const seeded = [...(state.baseline?.entrants ?? []), ...state.entrants];
  const nextSeed =
    1 + Math.max(0, ...seeded.filter((e) => e.division === division).map((e) => e.seed));

  return {
    pool,
    allowed: issues.length === 0,
    issues,
    returnCallMatchIds,
    assignedTeams,
    meetings,
    addedMatches,
    pendingForfeits,
    totalMatches: previousMatches.length + addedMatches,
    finals,
    nextSeed,
    revisionToken: hash({
      lifecycle: state.lifecycle,
      issues,
      returnCallMatchIds,
      pool: pool && [pool.id, pool.index, pool.entrantIds, pool.revision],
      previousMatches,
      addedMatches,
      pendingForfeits,
      finals,
      nextSeed,
      division,
      memberPlayerIds,
      identity,
      reason,
    }),
  };
}

export function addLateDoublesPair(
  state: TournamentState,
  envelope: CommandEnvelope,
  command: Command,
  basis: Record<string, number>,
) {
  const preview = reviewLateDoublesPair(state, command);
  requireFact(
    preview.revisionToken === command.revisionToken,
    'The admission changed since this preview. Review the late pair again.',
  );
  requireFact(preview.allowed && preview.pool && command.identity, preview.issues.join(' '));
  const { pool, nextSeed, meetings } = preview;
  const entrantId = stableId(`${envelope.id}:late-doubles-pair`);
  basis[pool.id] = pool.revision;
  state.entrants.push({
    id: entrantId,
    playerId: entrantId,
    memberPlayerIds: command.memberPlayerIds,
    name: command.identity.name,
    division: pool.division,
    seed: nextSeed,
    snapshotRank: null,
    snapshotScore: null,
    snapshotMean: null,
    snapshotSd: null,
    availability: 'available',
    revision: 0,
  });
  pool.entrantIds.push(entrantId);
  pool.revision++;

  const offset = lastPoolRound(state, pool.id);
  const pairings = buildRoundRobin(pool.entrantIds, meetings).filter(({ player1Id, player2Id }) =>
    [player1Id, player2Id].includes(entrantId),
  );
  const addedMatches = pairings.map((pairing, index) =>
    poolMatch(pool, envelope.id, { ...pairing, slot: 0 }, offset + index + 1),
  );
  // Apply existing withdrawal rules to the new pool matches only.
  advance({ ...state, matches: addedMatches }, envelope.at, envelope.id);
  if (sharedDispatch(state))
    for (const match of addedMatches) if (match.status === 'ready') match.readySince = envelope.at;
  state.matches.push(...addedMatches);
  state.settings.resourceRevision++;
}
