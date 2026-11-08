import { sharedDispatch } from './dispatch';
import { available } from './entrants';
import { unconfirmedCall } from './facts';
import { qualifierKey } from './qualifiers';
import type { Match, TournamentState } from './schemas';

export type QualifierChange = {
  bracketId: string;
  division: 'upper' | 'lower';
  stage: 'main' | 'consolation';
  poolId: string;
  poolIndex: number;
  place: number;
  beforeEntrantId: string | null;
  afterEntrantId: string | null;
};

export function openingRoute(state: TournamentState, change: QualifierChange) {
  const sides = state.matches.flatMap((match) =>
    match.bracketId === change.bracketId
      ? (['player1', 'player2'] as const).flatMap((side) => {
          const qualifier = match[`${side}Qualifier`];
          return qualifier && qualifierKey(qualifier) === qualifierKey(change)
            ? [{ match, side }]
            : [];
        })
      : [],
  );
  const opening = sides.length === 1 ? sides[0] : undefined;
  if (
    opening?.match.round === 1 &&
    !opening.match.parent1Id &&
    !opening.match.parent2Id &&
    opening.match[`${opening.side}Id`] === change.beforeEntrantId
  )
    return opening;
}

type Reviewed<T> =
  { allowed: true; value: T } | { allowed: false; issue: string; returnCallCandidate?: string };

export type ConsolationRoute = {
  root: NonNullable<ReturnType<typeof openingRoute>>;
  downstream: Match[];
  change: QualifierChange;
  entrants: (TournamentState['entrants'][number] | undefined)[];
};

export function dependants(state: TournamentState, root: Match) {
  const affected = new Map([[root.id, root]]);
  // A match is only visited once even if both of its parent sides are affected.
  for (const id of affected.keys())
    for (const match of state.matches)
      if (match.parent1Id === id || match.parent2Id === id || match.activation?.matchId === id)
        affected.set(match.id, match);
  affected.delete(root.id);
  return [...affected.values()];
}

export function outsideWinnerRoute(match: Match, bracketId: string) {
  return (
    match.bracketId !== bracketId ||
    match.activation ||
    match.parent1Outcome === 'loser' ||
    match.parent2Outcome === 'loser'
  );
}

function hasPlayFacts(match: Match) {
  return (
    match.started ||
    match.status === 'complete' ||
    match.outcome !== null ||
    match.completedAt !== null ||
    match.winnerId !== null ||
    match.score1 !== null ||
    match.score2 !== null ||
    match.liveScore1 !== null ||
    match.liveScore2 !== null ||
    match.progressRevision !== 0 ||
    match.resultCommandId !== null ||
    match.automaticFromRevision !== null
  );
}

export function championshipRouteBlocker(root: Match, downstream: Match[]) {
  if (downstream.some(hasPlayFacts))
    return 'A downstream championship pairing already has play or results.';
  if (downstream.some((match) => match.stationId || match.calledAt != null))
    return 'Return calls and remove scheduled station overrides on the affected championship route.';
  if (outsideWinnerRoute(root, root.bracketId!))
    return 'This replay requires an independent single-elimination route.';
}

function reviewedConsolationMatch(
  state: TournamentState,
  change: QualifierChange,
): Reviewed<ConsolationRoute> {
  const root = openingRoute(state, change);
  if (!root || !root.match.player1Id || !root.match.player2Id || root.match.outcome === 'bye')
    return {
      allowed: false,
      issue: 'The consolation place must feed a direct two-entrant opening set without a bye.',
    };
  const { match, side } = root;
  const opponentId = side === 'player1' ? match.player2Id : match.player1Id;
  const after = change.afterEntrantId!;
  const entrants = [opponentId, after].map((id) => state.entrants.find((e) => e.playerId === id));
  if (after === opponentId || entrants.some((e) => !e || !available(e)))
    return {
      allowed: false,
      issue: 'Both entrants in the updated consolation pairing must be available.',
    };

  const downstream = dependants(state, match);
  const route = [match, ...downstream];
  const routeIds = new Set(route.map(({ id }) => id));
  if (state.reports.some((report) => routeIds.has(report.matchId)))
    return { allowed: false, issue: 'The affected consolation route has score report history.' };
  if (state.supersededPlayedSets?.some((set) => routeIds.has(set.replacementMatchId)))
    return { allowed: false, issue: 'The consolation route already has a reviewed replay.' };
  if (route.some((m) => m.held || m.qualificationBlocks?.length))
    return {
      allowed: false,
      issue: 'Resolve the organiser hold or qualification review on the consolation route.',
    };
  if (route.some(hasPlayFacts))
    return { allowed: false, issue: 'The affected consolation route already has play or results.' };
  if (route.some((m) => m.status === 'playing' || m.calledAt != null || m.callLocation != null))
    return {
      allowed: false,
      issue: 'Return any untaken call on the consolation route before reviewing this change.',
      returnCallCandidate:
        sharedDispatch(state) && unconfirmedCall(match) && match.stationId === null
          ? match.id
          : undefined,
    };
  if (match.status !== 'ready' || route.some((m) => m.stationId))
    return {
      allowed: false,
      issue: 'The consolation route must be ready and free of scheduled station overrides.',
    };
  if (
    route.some((m) => outsideWinnerRoute(m, change.bracketId)) ||
    downstream.some((m) =>
      (['1', '2'] as const).some(
        (side) => routeIds.has(m[`parent${side}Id`] ?? '') && m[`player${side}Id`] !== null,
      ),
    )
  )
    return {
      allowed: false,
      issue: 'The consolation route already has derived advancement or unsupported feeders.',
    };

  return { allowed: true, value: { root, downstream, change, entrants } };
}

export function reciprocalRoutes(
  state: TournamentState,
  changes: QualifierChange[],
): Reviewed<{ main: QualifierChange; companion: ConsolationRoute }> {
  const main = changes.find(({ stage }) => stage === 'main');
  const consolation = changes.find(({ stage }) => stage === 'consolation');
  if (
    changes.length !== 2 ||
    !main?.beforeEntrantId ||
    !main.afterEntrantId ||
    !consolation ||
    main.division !== consolation.division ||
    main.poolId !== consolation.poolId ||
    main.beforeEntrantId !== consolation.afterEntrantId ||
    main.afterEntrantId !== consolation.beforeEntrantId
  )
    return {
      allowed: false,
      issue:
        'This replay requires a reciprocal championship and consolation place change in one pool.',
    };

  const fields = state.brackets.flatMap((bracket) => bracket.entrantIds);
  if (
    [main.beforeEntrantId, main.afterEntrantId].some(
      (id) => fields.filter((entrantId) => entrantId === id).length !== 1,
    )
  )
    return {
      allowed: false,
      issue: 'An affected entrant is already assigned in more than one finals place.',
    };

  const companion = reviewedConsolationMatch(state, consolation);
  return companion.allowed
    ? { allowed: true, value: { main, companion: companion.value } }
    : companion;
}
