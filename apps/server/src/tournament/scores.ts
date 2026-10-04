import { advance } from './brackets';
import { requireFact, resolved, sameScore } from './facts';
import type { CommandEnvelope, Match, TournamentState } from './schemas';

function winner(command: Extract<CommandEnvelope['command'], { kind: 'score' }>, match: Match) {
  requireFact(
    match.player1Id && match.player2Id && match.player1Id !== match.player2Id,
    'Both real opponents must be known.',
  );
  if (command.outcome === 'forfeit') {
    requireFact(
      command.score1 === null && command.score2 === null,
      'Forfeits do not invent played games.',
    );
    requireFact(
      command.winnerId === match.player1Id || command.winnerId === match.player2Id,
      'Select the advancing player for a forfeit.',
    );
    return command.winnerId;
  }
  requireFact(
    command.score1 !== null && command.score2 !== null && command.score1 !== command.score2,
    'A played result needs a decisive score.',
  );
  const inferred = command.score1 > command.score2 ? match.player1Id : match.player2Id;
  requireFact(
    !command.winnerId || command.winnerId === inferred,
    'Winner disagrees with the score.',
  );
  return inferred;
}

export function applyScore(
  state: TournamentState,
  match: Match,
  result: Pick<Match, 'score1' | 'score2' | 'winnerId' | 'outcome'>,
  at: number,
  automatic: boolean,
  commandId: string,
) {
  if (resolved(match)) {
    requireFact(match.outcome !== 'bye', 'An automatic bye is fixed by the draw.');
    if (match.stage === 'group' && state.brackets.length)
      requireFact(
        sameScore(match, result),
        'Finals use this pool result; a reviewed qualifier correction is required.',
      );
    if (match.winnerId !== result.winnerId) {
      const descendants = new Set([match.id]);
      for (const item of [...state.matches].sort((a, b) => a.round - b.round)) {
        if (descendants.has(item.parent1Id ?? '') || descendants.has(item.parent2Id ?? '')) {
          requireFact(
            !item.started && !resolved(item),
            'Winner change needs a ruling for downstream actual play.',
          );
          descendants.add(item.id);
        }
      }
    }
  }
  Object.assign(match, result, {
    status: 'complete',
    stationId: null,
    completedAt: at,
    automaticFromRevision: automatic ? match.revision : null,
    revision: match.revision + 1,
  });
  match.resultCommandId = commandId;
  if (match.poolId) {
    const pool = state.pools.find((p) => p.id === match.poolId)!;
    pool.order = null;
    pool.revision++;
  }
  state.settings.resourceRevision++;
  advance(state, at, commandId);
}

export function recordScore(
  next: TournamentState,
  envelope: CommandEnvelope,
  command: Extract<CommandEnvelope['command'], { kind: 'score' }>,
  basis: Record<string, number>,
) {
  let reportId: string | null = null;
  const match = next.matches.find((m) => m.id === command.matchId);
  requireFact(match, 'Match not found.');
  basis[match.id] = match.revision;
  for (const parentId of [match.parent1Id, match.parent2Id]) {
    if (parentId) basis[parentId] = next.matches.find((m) => m.id === parentId)!.revision;
  }
  const winnerId = winner(command, match);
  requireFact(
    ['ready', 'playing', 'complete'].includes(match.status),
    'The pairing is unresolved.',
  );
  const result = { ...command, winnerId };
  if (envelope.operator) {
    requireFact(
      match.revision === command.expectedRevision,
      'This match changed. Refresh and try again.',
    );
    applyScore(next, match, result, envelope.at, false, envelope.id);
  } else {
    requireFact(
      next.settings.published && next.settings.playerReports && command.outcome === 'played',
      'Player reporting is unavailable.',
    );
    requireFact(
      !next.entrants.some(
        (e) =>
          [match.player1Id, match.player2Id].includes(e.playerId) && e.availability === 'withdrawn',
      ),
      'An organiser must resolve withdrawn players.',
    );
    const own = next.reports.filter((r) => r.actorId === envelope.actorId);
    requireFact(
      !own.some((r) => r.matchId === match.id && r.status === 'pending'),
      'Your report is already pending.',
    );
    requireFact(
      own.filter((r) => r.status === 'pending').length < 30 &&
        own.filter((r) => r.createdAt > envelope.at - 60_000).length < 6,
      'Too many score reports.',
    );
    const policy = next.settings.scoreReportingMode === 'approve_unless_disputed';
    const automaticResult =
      policy &&
      match.revision === command.expectedRevision + 1 &&
      match.automaticFromRevision === command.expectedRevision;
    requireFact(
      match.revision === command.expectedRevision || automaticResult,
      'This match changed. Refresh before reporting.',
    );
    requireFact(
      !resolved(match) || (policy && match.outcome === 'played'),
      'An organiser must correct this result.',
    );
    const priorConflicts = next.reports.some(
      (r) =>
        r.matchId === match.id &&
        r.status === 'pending' &&
        r.expectedRevision === match.revision &&
        !sameScore(r, result),
    );
    if (priorConflicts)
      for (const report of next.reports.filter(
        (r) =>
          r.matchId === match.id && r.status === 'pending' && r.expectedRevision === match.revision,
      ))
        report.isDispute = true;
    const complete = resolved(match);
    const agrees = complete && sameScore(match, result);
    const pool = next.pools.find((p) => p.id === match.poolId);
    const selfRun = Boolean(
      match.status === 'playing' &&
      match.stationId &&
      pool?.active &&
      pool.selfRun &&
      pool.autoAcceptScores &&
      pool.stationIds.includes(match.stationId),
    );
    const accepted = agrees || (!complete && (policy || selfRun) && !priorConflicts);
    reportId = envelope.id;
    next.reports.push({
      id: reportId,
      matchId: match.id,
      actorId: envelope.actorId,
      requestId: envelope.requestId,
      submittedRevision: command.expectedRevision,
      expectedRevision: match.revision,
      score1: command.score1,
      score2: command.score2,
      winnerId,
      outcome: command.outcome,
      status: accepted ? 'approved' : 'pending',
      autoApproved: accepted && !complete,
      isDispute: (complete && !agrees) || priorConflicts,
      createdAt: envelope.at,
    });
    if (accepted && !complete) {
      for (const report of next.reports.filter(
        (r) =>
          r.matchId === match.id &&
          r.status === 'pending' &&
          r.expectedRevision === match.revision &&
          sameScore(r, result),
      )) {
        report.status = 'approved';
        report.isDispute = false;
      }
      applyScore(next, match, result, envelope.at, true, envelope.id);
    }
  }
  return reportId;
}
