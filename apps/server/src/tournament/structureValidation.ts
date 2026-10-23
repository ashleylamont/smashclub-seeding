import { requireFact } from './facts';
import type { TournamentBaseline } from './schemas';

/** Validate recorded topology without regenerating decisions during replay. */
export function validateKnockoutBaseline(baseline: TournamentBaseline) {
  const bracket = baseline.brackets?.[0];
  const entrants = new Set(baseline.entrants.map((e) => e.playerId));
  requireFact(
    baseline.pools.length === 0 &&
      baseline.brackets?.length === 1 &&
      bracket?.division === 'upper' &&
      bracket.stage === 'main',
    'A knockout needs one open bracket and no pools.',
  );
  requireFact(
    bracket.entrantIds.length === entrants.size &&
      new Set(bracket.entrantIds).size === entrants.size &&
      bracket.entrantIds.every((id) => entrants.has(id)),
    'Knockout entrants must match the captured roster.',
  );
  const byId = new Map(baseline.matches.map((m) => [m.id, m]));
  const roots = baseline.matches
    .filter((m) => !m.parent1Id && !m.parent2Id)
    .flatMap((m) => [m.player1Id, m.player2Id].filter((id): id is string => Boolean(id)));
  requireFact(
    roots.length === entrants.size && new Set(roots).size === entrants.size,
    'Every entrant must occupy exactly one initial knockout slot.',
  );
  for (const match of baseline.matches) {
    requireFact(
      match.bracketId === bracket.id &&
        !match.poolId &&
        match.division === 'upper' &&
        match.stage === 'main' &&
        match.score1 === null &&
        match.score2 === null &&
        match.stationId === null,
      'Invalid initial knockout match.',
    );
    for (const id of [match.parent1Id, match.parent2Id])
      requireFact(
        !id || (byId.has(id) && byId.get(id)!.round < match.round),
        'Knockout dependencies must point to earlier matches.',
      );
    if (match.activation)
      requireFact(
        match.bracketLane === 'reset' &&
          byId.has(match.activation.matchId) &&
          byId.get(match.activation.matchId)!.round < match.round,
        'Invalid conditional reset dependency.',
      );
    if (baseline.structure === 'single_elimination')
      requireFact(
        match.parent1Outcome !== 'loser' && match.parent2Outcome !== 'loser' && !match.activation,
        'Single elimination cannot contain loser feeds or a reset.',
      );
    if (match.outcome === 'bye')
      requireFact(
        Boolean(match.player1Id) !== Boolean(match.player2Id) &&
          match.winnerId === (match.player1Id ?? match.player2Id),
        'Invalid automatic bye.',
      );
    if (match.outcome === 'no_contest')
      requireFact(
        !match.winnerId && !match.player1Id && !match.player2Id,
        'Invalid automatic empty match.',
      );
  }
}
