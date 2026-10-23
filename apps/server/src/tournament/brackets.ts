import { finalsRoles, isKnockout } from '@smashclub/shared';
import { instantiateElimination } from './structureAdapter';
import { buildFormatFinals, buildEliminationTree } from '@smashclub/engine';
import { requireFact, resolved, stableId } from './facts';
import type { CommandEnvelope, TournamentState } from './schemas';

/** Execute advancement once on the decision path; persist resulting matches. */
export function advance(state: TournamentState, at: number, commandId: string) {
  const withdrawn = new Set(
    state.entrants.filter((e) => e.availability === 'withdrawn').map((e) => e.playerId),
  );
  const byId = new Map(state.matches.map((m) => [m.id, m]));
  for (const match of [...state.matches].sort(
    (a, b) => a.round - b.round || a.id.localeCompare(b.id),
  )) {
    const parents = [match.parent1Id, match.parent2Id].filter((id): id is string => Boolean(id));
    if (!parents.every((id) => resolved(byId.get(id)!))) continue;
    if (match.activation) {
      const parent = byId.get(match.activation.matchId)!;
      if (!resolved(parent)) continue;
      const required = match.activation.winnerSide === 1 ? parent.player1Id : parent.player2Id;
      if (!required || parent.winnerId !== required) {
        if (!resolved(match))
          Object.assign(match, {
            status: 'complete',
            outcome: 'no_contest',
            skipped: true,
            completedAt: at,
            revision: match.revision + 1,
            resultCommandId: commandId,
          });
        continue;
      }
    }
    const feed = (
      id: string | null,
      outcome: 'winner' | 'loser' | undefined,
      current: string | null,
    ) => {
      if (!id) return current;
      const parent = byId.get(id)!;
      if (outcome !== 'loser') return parent.winnerId;
      return parent.winnerId
        ? parent.winnerId === parent.player1Id
          ? parent.player2Id
          : parent.player1Id
        : null;
    };
    const p1 = feed(match.parent1Id, match.parent1Outcome, match.player1Id);
    const p2 = feed(match.parent2Id, match.parent2Outcome, match.player2Id);
    if (p1 !== match.player1Id || p2 !== match.player2Id) {
      requireFact(
        !match.started && !resolved(match),
        'A downstream match already has actual play.',
      );
      Object.assign(match, {
        player1Id: p1,
        player2Id: p2,
        revision: match.revision + 1,
        status: p1 && p2 ? 'ready' : 'blocked',
      });
    }
    if (match.started || resolved(match)) continue;
    const players = [match.player1Id, match.player2Id].filter((p): p is string => Boolean(p));
    const remaining = players.filter((p) => !withdrawn.has(p));
    if (match.stage === 'group' && remaining.length === 1 && players.length === 2) {
      match.status = 'blocked';
      match.blockedReason = 'Player withdrawn: awaiting organiser forfeit decision';
      match.stationId = null;
      continue;
    }
    if (remaining.length === 2) {
      match.status = 'ready';
      continue;
    }
    // No game evidence for withdrawals, vacancies, or automatic byes.
    Object.assign(match, {
      status: 'complete',
      outcome: remaining.length === 0 ? 'no_contest' : players.length === 1 ? 'bye' : 'forfeit',
      winnerId: remaining[0] ?? null,
      score1: null,
      score2: null,
      completedAt: at,
      stationId: null,
      revision: match.revision + 1,
      automaticFromRevision: null,
    });
    match.resultCommandId = commandId;
  }
}
export function drawFinals(state: TournamentState, envelope: CommandEnvelope) {
  requireFact(
    !isKnockout(state.baseline?.structure),
    'Knockout brackets are chosen at draw lock and have no separate finals draw.',
  );
  requireFact(!state.brackets.length, 'Finals have already been drawn.');
  requireFact(
    state.reports.every((r) => r.status !== 'pending'),
    'Resolve pending reports first.',
  );
  requireFact(
    state.matches.every(resolved) && state.pools.every((p) => p.order),
    'Resolve pools and confirm their placements first.',
  );
  if (state.baseline!.structure === 'round_robin') {
    state.brackets.push({
      id: stableId(`${envelope.id}:round-robin`),
      division: 'upper',
      stage: 'main',
      entrantIds: state.pools[0]!.order!,
    });
    return;
  }
  for (const division of state.baseline!.structure !== 'dual_division' && state.baseline!.structure
    ? (['upper'] as const)
    : (['upper', 'lower'] as const)) {
    const finishers = state.pools
      .filter((p) => p.division === division)
      .flatMap((p) =>
        p
          .order!.filter(
            (id) =>
              !state.entrants.some((e) => e.playerId === id && e.availability === 'withdrawn'),
          )
          .map((playerId, index) => ({ playerId, poolIndex: p.index, place: index + 1 })),
      );
    for (const stage of finalsRoles(state.baseline!.structure, state.baseline!.structureOptions)) {
      const entrantIds = buildFormatFinals(
        state.baseline!.structure,
        finishers,
        stage,
        state.baseline!.structureOptions,
      ).map((p) => p.playerId);
      const bracketId = stableId(`${envelope.id}:${division}:${stage}`);
      state.brackets.push({ id: bracketId, division, stage, entrantIds });
      const tree = buildEliminationTree(
        bracketId,
        entrantIds.map((entrantId) => ({ kind: 'entrant', entrantId })),
      );
      state.matches.push(...instantiateElimination(tree, bracketId, division, stage));
    }
  }
  advance(state, envelope.at, envelope.id);
}
