import { previewRestoration, restoreEntrant } from './restoration';
import { isKnockout } from '@smashclub/shared';
import { buildRoundRobin, poolLabel } from '@smashclub/tournament-formats';
import { hash, requireFact, resolved, TournamentConflict, unconfirmedCall } from './facts';
import { advance, matchInputStatus } from './brackets';
import {
  attendancePoolCandidates,
  poolMatch,
  lastPoolRound,
  poolAttendanceBlocker,
} from './poolAttendance';
import { completeCommandProgression } from './progression';
import { hasCurrentPendingScoreReview } from './scoreReview';
import { projectMatchLabels } from './matchNames';
import { qualifierFieldFrozen } from './qualifiers';
import {
  hasFixedLegacyPoolQualifiers,
  hasLegacyQualifier,
  legacyPendingRosterMessage,
} from './legacyFinalQualifiers';
import type { CommandEnvelope, Match, TournamentCommand, TournamentState } from './schemas';

type Input = Extract<CommandEnvelope['command'], { kind: 'attendance' }>;
type Pool = TournamentState['pools'][number];
type WithdrawalConsequence = {
  state?: 'called' | 'playing' | 'held';
  forfeit?: 'automatic' | 'organiser';
};
type AttendancePreview = ReturnType<typeof ordinaryAttendancePreview> &
  ReturnType<typeof reviewWithdrawal> & {
    restoration?: ReturnType<typeof previewRestoration>['restoration'];
  };
export function attendancePreview(
  state: TournamentState,
  input: Parameters<typeof ordinaryAttendancePreview>[1],
): AttendancePreview {
  if (input.action === 'restore') return previewRestoration(state, input.playerId, input.reason);
  const preview = ordinaryAttendancePreview(state, input);
  if (input.action === 'withdraw' && preview.allowed) {
    try {
      preview.issues.push(
        ...withdrawalScoreReviewIssues(state, () =>
          projectWithdrawal(state, input.playerId, preview),
        ),
      );
    } catch (error) {
      if (!(error instanceof TournamentConflict)) throw error;
      preview.issues.push(error.message);
    }
    preview.allowed = preview.issues.length === 0;
  }
  return { ...preview, ...reviewWithdrawal(state, input, preview.allowed) };
}

export function attendanceEffect(
  preview: Pick<AttendancePreview, 'addedMatches' | 'affectedMatches'>,
) {
  return { addedMatches: preview.addedMatches, affectedMatches: preview.affectedMatches.length };
}

function ordinaryAttendancePreview(
  state: TournamentState,
  input: Omit<Input, 'kind' | 'revisionToken' | 'entrant' | 'reason' | 'approveRedistribution'> & {
    approveRedistribution?: boolean;
    reason?: string;
  },
) {
  const entrant = state.entrants.find((e) => e.playerId === input.playerId);
  const division = (input.action === 'add' ? input.division : entrant?.division) ?? 'lower';
  const protectedPool = (id: string) => poolHasCallsOrHistory(state, id);
  const candidates = attendancePoolCandidates(state, division);
  const open = candidates.filter((p) => !protectedPool(p.id));
  const pool =
    input.action === 'add'
      ? open[0]
      : state.pools.find((p) => p.entrantIds.includes(input.playerId));
  const issues: string[] = [];
  if (state.baseline?.competitionFormat === 'doubles' && input.action === 'add')
    issues.push('Use the reviewed late-pair workflow to add a doubles pair.');
  if (!['locked', 'unlocked'].includes(state.lifecycle))
    issues.push('Attendance changes require an open locked event.');
  issues.push(...finalsRosterIssues(state, input.action, division, pool?.id));
  if (input.action === 'add' ? entrant : !entrant)
    issues.push(
      input.action === 'add'
        ? 'This player is already in the event.'
        : 'This player is not attending.',
    );
  const lateAddRecovery = lateAddCalls(
    state,
    input,
    candidates,
    Boolean(pool) || issues.length > 0,
  );
  if (lateAddRecovery) {
    const calls = lateAddRecovery.matchIds.length === 1 ? 'call' : 'calls';
    issues.push(
      `Return the untaken ${calls} in Pool ${poolLabel(lateAddRecovery.poolIndex)}, then refresh this preview.`,
    );
  } else if (!pool && !(input.action === 'withdraw' && isKnockout(state.baseline?.structure))) {
    issues.push('No eligible pool is available.');
  }
  if (
    input.action === 'add' &&
    input.poolIndex !== undefined &&
    input.poolIndex !== (pool?.index ?? lateAddRecovery?.poolIndex)
  )
    issues.push('The smallest open pool changed.');
  const draw = reviewAttendanceDraw(state, input, {
    pool,
    candidates,
    open,
    hasOtherIssues: issues.length > 0,
  });
  issues.push(...draw.issues);
  const returnCallMatchIds = lateAddRecovery?.matchIds ?? draw.returnCallMatchIds;
  return {
    allowed: !issues.length,
    issues,
    ...(returnCallMatchIds.length ? { returnCallMatchIds } : {}),
    requiresExternalAcknowledgement: false,
    requiresRedistributionApproval: Boolean(draw.relocations.length),
    relocations: draw.relocations,
    division,
    poolIndex: pool?.index ?? null,
    poolSize: pool?.entrantIds.length ?? 0,
    addedMatches:
      input.action === 'add'
        ? (pool?.entrantIds.length ?? 0) *
          (state.baseline?.structureOptions?.roundRobinMeetings ?? 1)
        : 0,
    affectedMatches: draw.affectedMatches,
    revisionToken: hash({
      entrants: state.entrants,
      pools: state.pools,
      matches: state.matches,
      reports: state.reports,
      brackets: state.brackets,
      lifecycle: state.lifecycle,
    }),
  };
}

function reviewAttendanceDraw(
  state: TournamentState,
  { action, playerId }: Pick<Input, 'action' | 'playerId'>,
  {
    pool,
    candidates,
    open,
    hasOtherIssues,
  }: {
    pool: Pool | undefined;
    candidates: readonly Pool[];
    open: readonly Pool[];
    hasOtherIssues: boolean;
  },
) {
  const involved = state.matches.filter((m) => [m.player1Id, m.player2Id].includes(playerId));
  const matchReview = reviewAffectedMatches(action, involved, state.reports);
  const remaining = pool?.entrantIds.filter((id) => action !== 'no_show' || id !== playerId) ?? [];
  const relocations = attendanceRelocations(state, action, pool, remaining, open);
  const redistributionCalls =
    action === 'redistribute' &&
    pool &&
    remaining.length === 2 &&
    !hasOtherIssues &&
    !relocations.length
      ? redistributionCallRecovery(state, pool, candidates)
      : [];
  const issues = redistributionCalls.length
    ? [
        `Return the untaken ${redistributionCalls.length === 1 ? 'call' : 'calls'}, then refresh this preview.`,
      ]
    : matchReview.issues;
  if (action === 'no_show' && remaining.length < 2)
    issues.push('A pool needs at least two players.');
  if (action === 'redistribute' && remaining.length !== 2)
    issues.push('Only a two-player pool can be redistributed.');
  if (action === 'redistribute' && !relocations.length && !redistributionCalls.length)
    issues.push('No safe redistribution is available.');
  const labels = projectMatchLabels(state);
  return {
    issues,
    returnCallMatchIds:
      action === 'no_show' && !hasOtherIssues && issues.length === 1
        ? matchReview.untakenCallIds
        : redistributionCalls,
    relocations,
    affectedMatches: involved.map((m) => ({
      id: m.id,
      label: labels.get(m.id)?.label ?? m.label,
      status: m.status,
    })),
  };
}

function attendanceRelocations(
  state: TournamentState,
  action: Input['action'],
  pool: Pool | undefined,
  remaining: string[],
  open: readonly Pool[],
) {
  if (
    !pool ||
    remaining.length !== 2 ||
    !['no_show', 'redistribute'].includes(action) ||
    poolHasCallsOrHistory(state, pool.id)
  )
    return [];
  const destinations = relocationDestinations(pool.id, open);
  return destinations.length === 2
    ? remaining.map((playerId, i) => ({
        playerId,
        fromPoolIndex: pool.index,
        toPoolIndex: destinations[i]!.index,
      }))
    : [];
}

function relocationDestinations(sourceId: string, open: readonly Pool[]) {
  const targets = open.filter((pool) => pool.id !== sourceId);
  const together = targets.find((pool) => pool.entrantIds.length <= 3);
  return together ? [together, together] : targets.slice(0, 2);
}

function redistributionCallRecovery(
  state: TournamentState,
  source: Pool,
  candidates: readonly Pool[],
) {
  const reported = new Set(state.reports.map((report) => report.matchId));
  const sourceBlocker = poolAttendanceBlocker(state, source, reported);
  if (typeof sourceBlocker === 'string') return [];
  const sourceCalls = sourceBlocker?.matchIds ?? [];
  const open: Pool[] = [];
  const called: { pool: Pool; matchIds: string[] }[] = [];
  for (const pool of candidates) {
    if (pool.id === source.id) continue;
    const blocker = poolAttendanceBlocker(state, pool, reported);
    if (!blocker) open.push(pool);
    else if (typeof blocker === 'object') called.push({ pool, matchIds: blocker.matchIds });
  }
  if (relocationDestinations(source.id, open).length === 2) return sourceCalls;

  // Prefer returning calls in one destination in normal pool order. If one
  // cannot fit the move, it can only succeed by splitting across two targets.
  const single = called.find(
    ({ pool }) => relocationDestinations(source.id, [...open, pool]).length === 2,
  );
  if (single) return [...sourceCalls, ...single.matchIds];
  const firstTwo = called.slice(0, 2);
  return firstTwo.length === 2
    ? [...sourceCalls, ...firstTwo.flatMap(({ matchIds }) => matchIds)]
    : [];
}

function lateAddCalls(
  state: TournamentState,
  { action, poolIndex: reviewedPoolIndex }: Pick<Input, 'action' | 'poolIndex'>,
  candidates: readonly Pool[],
  hasPlacementOrOtherBlocker: boolean,
) {
  if (action !== 'add' || hasPlacementOrOtherBlocker) return;
  const reported = new Set(state.reports.map((report) => report.matchId));
  for (const pool of candidates) {
    const blocker = poolAttendanceBlocker(state, pool, reported);
    if (!blocker || typeof blocker !== 'object') continue;
    if (reviewedPoolIndex === undefined || reviewedPoolIndex === pool.index)
      return { poolIndex: pool.index, matchIds: blocker.matchIds };
    return;
  }
}

function projectWithdrawal(
  state: TournamentState,
  playerId: string,
  { poolIndex, revisionToken }: Pick<AttendancePreview, 'poolIndex' | 'revisionToken'>,
) {
  const trial = structuredClone(state);
  const envelope: CommandEnvelope = {
    id: 'withdrawal-preview',
    requestId: 'withdrawal-preview',
    actorId: 'withdrawal-preview',
    at: 0,
    operator: true,
    command: {
      kind: 'attendance',
      action: 'withdraw',
      playerId,
      revisionToken,
      reason: 'withdraw',
      approveRedistribution: false,
    },
  };
  withdrawEntrant(trial, envelope, playerId, poolIndex);
  completeCommandProgression(state, trial, envelope, {});
  return trial.matches;
}

export function requireWithdrawalScoreReview(
  previous: TournamentState,
  next: TournamentState,
  command: TournamentCommand,
) {
  if (
    (command.kind === 'attendance' && command.action === 'withdraw') ||
    (command.kind === 'availability' && command.availability === 'withdrawn')
  ) {
    const issues = withdrawalScoreReviewIssues(previous, () => next.matches);
    requireFact(!issues.length, issues.join(' '));
  }
}

/** A revision change would make current evidence unapprovable, even on a later bracket feed. */
function withdrawalScoreReviewIssues(
  previous: TournamentState,
  getNextMatches: () => readonly Match[],
) {
  const reports = previous.reports.filter(
    (report) => report.outcome === 'played' && report.status === 'pending',
  );
  if (!reports.length) return [];
  const pending = previous.matches.filter(
    (match) => !resolved(match) && hasCurrentPendingScoreReview(match, reports),
  );
  if (!pending.length) return [];
  const revisions = new Map(getNextMatches().map(({ id, revision }) => [id, revision]));
  const affected = pending.filter((match) => revisions.get(match.id) !== match.revision);
  if (!affected.length) return [];
  const labels = projectMatchLabels(previous);
  return affected.map(
    (match) =>
      `Approve or reject the pending played score for ${labels.get(match.id)?.label ?? match.label} in Score reviews before withdrawing this entrant.`,
  );
}

function reviewWithdrawal(
  state: TournamentState,
  { action, playerId }: Pick<Input, 'action' | 'playerId'>,
  allowed: boolean,
): { warnings: string[]; withdrawalMatches?: Record<string, WithdrawalConsequence> } {
  if (action !== 'withdraw') return { warnings: [] };
  const byId = new Map(state.matches.map((match) => [match.id, match]));
  const withdrawn = new Set(
    state.entrants
      .filter((entrant) => entrant.availability === 'withdrawn')
      .map((entrant) => entrant.playerId),
  );
  const matches: Record<string, WithdrawalConsequence> = {};
  let called = false;
  let poolForfeit = false;
  for (const match of state.matches) {
    if (resolved(match) || ![match.player1Id, match.player2Id].includes(playerId)) continue;
    const consequence: WithdrawalConsequence = {};
    if (match.status === 'playing') {
      consequence.state = unconfirmedCall(match) ? 'called' : 'playing';
      called ||= consequence.state === 'called';
    } else if (match.started && match.status === 'blocked') consequence.state = 'held';
    const opponent = match.player1Id === playerId ? match.player2Id : match.player1Id;
    if (opponent && !withdrawn.has(opponent)) {
      poolForfeit ||= match.stage === 'group';
      if (allowed) {
        if (match.started || match.stage === 'group') consequence.forfeit = 'organiser';
        else if (matchInputStatus(match, byId) === 'ready') consequence.forfeit = 'automatic';
      }
    }
    if (consequence.state || consequence.forfeit) matches[match.id] = consequence;
  }
  const warnings = ['Completed results stay recorded.'];
  if (allowed && called)
    warnings.push(
      'Calls awaiting a confirmed start are released. Confirm the start first if play is underway.',
    );
  if (poolForfeit) warnings.push('Outstanding pool pairings need an explicit forfeit.');
  return { withdrawalMatches: matches, warnings };
}

function reviewAffectedMatches(
  action: Input['action'],
  matches: readonly Match[],
  reports: TournamentState['reports'],
) {
  const untakenCallIds =
    action === 'withdraw' ? [] : matches.filter(unconfirmedCall).map(({ id }) => id);
  const issues: string[] = [];
  if (untakenCallIds.length)
    issues.push(
      untakenCallIds.length === 1
        ? 'Return this entrant’s untaken call before changing the draw.'
        : 'Return this entrant’s untaken calls before changing the draw.',
    );
  if (
    action === 'no_show' &&
    matches.some(
      (match) =>
        match.started || resolved(match) || reports.some((report) => report.matchId === match.id),
    )
  )
    issues.push('This player has match history. Record a withdrawal.');
  return { issues, untakenCallIds };
}

function finalsRosterIssues(
  state: TournamentState,
  action: Input['action'],
  division: TournamentState['pools'][number]['division'],
  poolId: string | undefined,
) {
  if (action !== 'withdraw' && qualifierFieldFrozen(state, division))
    return ['Remove unplayed finals before changing the pool draw.'];
  if (action === 'withdraw' && poolId && hasLegacyQualifier(state, poolId, 'pending'))
    return [legacyPendingRosterMessage];
  return [];
}

export function applyAttendance(state: TournamentState, envelope: CommandEnvelope, input: Input) {
  const preview =
    input.action === 'restore'
      ? previewRestoration(state, input.playerId, input.reason)
      : ordinaryAttendancePreview(state, input);
  requireFact(
    preview.revisionToken === input.revisionToken,
    'The event changed since this preview. Review the updated attendance change.',
  );
  requireFact(preview.allowed, preview.issues.join(' '));
  if (input.action === 'restore') {
    restoreEntrant(state, envelope, input.playerId);
    return;
  }
  if (input.action === 'withdraw') {
    withdrawEntrant(state, envelope, input.playerId, preview.poolIndex);
  } else {
    const pool = state.pools.find(
      (p) => p.division === preview.division && p.index === preview.poolIndex,
    );
    requireFact(pool, 'An eligible pool is required.');
    const touched = new Set([pool.id]);
    if (input.action === 'add') {
      requireFact(input.entrant, 'Capture the new entrant identity first.');
      state.entrants.push({
        ...input.entrant,
        playerId: input.playerId,
        division: preview.division,
        seed:
          Math.max(
            0,
            ...state.entrants.filter((e) => e.division === preview.division).map((e) => e.seed),
          ) + 1,
        availability: 'available',
        revision: 0,
      });
      pool.entrantIds.push(input.playerId);
    } else {
      if (input.action === 'redistribute')
        requireFact(input.approveRedistribution, 'Approve the proposed moves first.');
      if (input.action === 'no_show') {
        state.entrants = state.entrants.filter((e) => e.playerId !== input.playerId);
        pool.entrantIds = pool.entrantIds.filter((id) => id !== input.playerId);
        state.matches = state.matches.filter(
          (m) => ![m.player1Id, m.player2Id].includes(input.playerId),
        );
      }
      if (input.approveRedistribution)
        for (const move of preview.relocations) {
          const target = state.pools.find(
            (p) => p.division === preview.division && p.index === move.toPoolIndex,
          )!;
          touched.add(target.id);
          target.entrantIds.push(move.playerId);
          pool.entrantIds = pool.entrantIds.filter((id) => id !== move.playerId);
        }
    }
    for (const changed of state.pools.filter((p) => touched.has(p.id))) {
      changed.order = null;
      changed.revision++;
      // Preserve all unrelated actual pairings; only removed unplayed pairs disappear.
      state.matches = state.matches.filter(
        (m) =>
          m.poolId !== changed.id ||
          (changed.entrantIds.includes(m.player1Id!) && changed.entrantIds.includes(m.player2Id!)),
      );
      // Retain the chosen order. New pairings occupy later circle rounds so
      // a newcomer cannot appear twice in an existing round.
      const addedRoundOffset = lastPoolRound(state, changed.id);
      for (const pairing of buildRoundRobin(
        changed.entrantIds,
        state.baseline?.structureOptions?.roundRobinMeetings ?? 1,
      )) {
        const { player1Id: p1, player2Id: p2 } = pairing;
        const existing = state.matches.filter(
          (m) =>
            m.poolId === changed.id &&
            [m.player1Id, m.player2Id].includes(p1) &&
            [m.player1Id, m.player2Id].includes(p2),
        );
        if (existing.length >= pairing.meeting) continue;
        state.matches.push(
          poolMatch(changed, envelope.id, pairing, addedRoundOffset + pairing.round),
        );
      }
    }
    state.pools = state.pools.filter((p) => p.entrantIds.length);
    state.settings.resourceRevision++;
  }
  if (input.action === 'add') return attendanceEffect(preview);
}

function withdrawEntrant(
  state: TournamentState,
  envelope: CommandEnvelope,
  playerId: string,
  poolIndex: number | null,
) {
  const entrant = state.entrants.find((e) => e.playerId === playerId)!;
  const pool = state.pools.find((p) => p.division === entrant.division && p.index === poolIndex);
  entrant.availability = 'withdrawn';
  entrant.revision++;
  for (const match of state.matches) {
    if (match.status !== 'playing' || ![match.player1Id, match.player2Id].includes(playerId))
      continue;
    match.status = 'blocked';
    match.stationId = null;
    match.blockedReason = 'Player withdrawn: awaiting organiser forfeit decision';
  }
  if (
    pool &&
    !hasFixedLegacyPoolQualifiers(state, pool) &&
    (!state.settings.poolOrderPolicy || !qualifierFieldFrozen(state, pool.division))
  ) {
    pool.order = null;
    pool.revision++;
  }
  advance(state, envelope.at, envelope.id);
  state.settings.resourceRevision++;
}

function poolHasCallsOrHistory(state: TournamentState, id: string) {
  return state.matches.some(
    (match) =>
      match.poolId === id &&
      (match.started ||
        match.status === 'playing' ||
        resolved(match) ||
        state.reports.some((report) => report.matchId === match.id)),
  );
}
