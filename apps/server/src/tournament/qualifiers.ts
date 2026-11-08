import { hash, requireFact, resolved } from './facts';
import { hasCurrentPendingScoreReview } from './scoreReview';
import type { Match, QualifierSource, QualifierSlot, TournamentState } from './schemas';

export const rollingFinals = (state: TournamentState) =>
  state.settings.finalsProgression === 'rolling_pool_places_v1';
export const qualifierKey = (source: Pick<QualifierSource, 'poolId' | 'place'>) =>
  `${source.poolId}:${source.place}`;
export function sourceDescriptor(source: QualifierSource): QualifierSource {
  const { poolId, poolIndex, division, place, status } = source;
  return { poolId, poolIndex, division, place, status };
}
type Pool = TournamentState['pools'][number];

/** Earlier policies freeze the whole event. Combined draws freeze one division at a time. */
export function qualifierFieldFrozen(state: TournamentState, division: Pool['division']) {
  return state.brackets.some(
    (bracket) => !bracket.strengthSeeding || bracket.division === division,
  );
}

/** Rank bands compress around the eligible field without breaking any ties. */
export function qualifierGroups(pool: Pool) {
  return (pool.qualifierDecision?.groups ?? [])
    .map((group) =>
      group.filter((id) => !pool.qualifierRoster || pool.qualifierRoster.includes(id)),
    )
    .filter((group) => group.length > 0);
}

export function qualificationPlaces(
  state: TournamentState,
  pool: Pool,
): Pick<QualifierSlot, 'status' | 'entrantId' | 'candidateEntrantIds'>[] {
  const eligible = pool.qualifierRoster!;
  const reviewPending = state.matches.some(
    (m) => m.poolId === pool.id && hasCurrentPendingScoreReview(m, state.reports),
  );
  if (reviewPending) return eligible.map(() => ({ status: 'review_pending', entrantId: null }));
  if (pool.order)
    return pool.order
      .filter((id) => eligible.includes(id))
      .map((entrantId) => ({ status: 'resolved', entrantId }));
  if (pool.qualifierDecision)
    return qualifierGroups(pool).flatMap((group) =>
      group.map(() =>
        group.length === 1
          ? { status: 'resolved', entrantId: group[0]! }
          : { status: 'pending', entrantId: null, candidateEntrantIds: group },
      ),
    );
  return eligible.map(() => ({ status: 'pending', entrantId: null }));
}
function protectedMatch(state: TournamentState, match: Match) {
  return (
    match.started ||
    match.status === 'playing' ||
    resolved(match) ||
    state.reports.some((r) => r.matchId === match.id)
  );
}

/** Both winner and loser feeds inherit the qualification history of their actual pairing. */
export function qualifierDependencies(
  state: Pick<TournamentState, 'matches'>,
  match: Match,
): QualifierSource[] {
  const sources = new Map<string, QualifierSource>();
  const seen = new Set<string>();
  const visit = (item: Match) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    for (const source of [item.player1Qualifier, item.player2Qualifier])
      if (source) sources.set(qualifierKey(source), source);
    for (const id of [item.parent1Id, item.parent2Id]) {
      const parent = id ? state.matches.find((m) => m.id === id) : undefined;
      if (parent) visit(parent);
    }
  };
  visit(match);
  return [...sources.values()];
}

export function poolFinalsConsumed(state: TournamentState, poolId: string) {
  return (
    state.brackets.some(
      (bracket) =>
        bracket.strengthSeeding &&
        bracket.qualifierSlots?.some((source) => source.poolId === poolId),
    ) ||
    state.matches.some(
      (m) =>
        m.bracketId &&
        protectedMatch(state, m) &&
        qualifierDependencies(state, m).some((source) => source.poolId === poolId),
    )
  );
}

export function requirePoolCorrectionAllowed(state: TournamentState, poolId: string) {
  requireFact(
    !poolFinalsConsumed(state, poolId),
    'Finals already use this pool result or order. Return untaken calls and remove unplayed finals before correcting it; actual play and report history stay fixed.',
  );
}

export function qualificationReason(sources: readonly QualifierSource[]) {
  return `Waiting for qualification: ${sources
    .map(
      (source) =>
        `${source.division} pool ${String.fromCharCode(65 + source.poolIndex)} place ${source.place}${source.status === 'review_pending' ? ' (score review)' : ' (finishing order)'}`,
    )
    .join('; ')}`;
}

/** Persist slot identity changes only on the command path. A report hold never
 * retracts an actual call, played opponent, result or report history. */
export function reconcileRollingFinals(state: TournamentState, basis: Record<string, number>) {
  if (!rollingFinals(state)) return;
  let changed = false;
  const slots = new Map<string, QualifierSlot>();
  const consumed = new Map(state.pools.map((p) => [p.id, poolFinalsConsumed(state, p.id)]));
  const places = new Map(
    state.pools.filter((p) => p.qualifierRoster).map((p) => [p.id, qualificationPlaces(state, p)]),
  );
  for (const bracket of state.brackets) {
    if (!bracket.qualifierSlots) continue;
    for (const slot of bracket.qualifierSlots) {
      const before = hash(slot);
      const place = places.get(slot.poolId)?.[slot.place - 1];
      requireFact(place, 'The finishing order no longer fills its frozen qualifier field.');
      const { status, entrantId, candidateEntrantIds } = place;
      if (status === 'resolved') {
        requireFact(
          !consumed.get(slot.poolId) || !slot.entrantId || slot.entrantId === entrantId,
          'A qualifier change would rewrite a called or played finals route.',
        );
      }
      slot.status = status;
      if (status === 'resolved' || !consumed.get(slot.poolId)) slot.entrantId = entrantId;
      if (candidateEntrantIds) slot.candidateEntrantIds = candidateEntrantIds;
      else delete slot.candidateEntrantIds;
      slots.set(qualifierKey(slot), slot);
      changed ||= before !== hash(slot);
    }
    bracket.entrantIds = bracket.qualifierSlots.flatMap((slot) =>
      slot.entrantId ? [slot.entrantId] : [],
    );
  }
  for (const match of state.matches.filter((m) => m.bracketId)) {
    for (const side of [1, 2] as const) {
      const qualifierField = side === 1 ? 'player1Qualifier' : 'player2Qualifier';
      const playerField = side === 1 ? 'player1Id' : 'player2Id';
      const source = match[qualifierField];
      if (!source) continue;
      const slot = slots.get(qualifierKey(source))!;
      const descriptor = sourceDescriptor(slot);
      if (hash(source) !== hash(descriptor)) changed = true;
      match[qualifierField] = descriptor;
      if (match[playerField] !== slot.entrantId) {
        requireFact(
          !protectedMatch(state, match),
          'A finals pairing already has a call, actual play or report history.',
        );
        basis[match.id] ??= match.revision;
        match[playerField] = slot.entrantId;
        match.revision++;
        changed = true;
      }
    }
  }
  for (const match of state.matches.filter((m) => m.bracketId)) {
    const blocks = qualifierDependencies(state, match).filter((s) => s.status !== 'resolved');
    if (hash(match.qualificationBlocks ?? []) !== hash(blocks)) changed = true;
    if (blocks.length) {
      match.qualificationBlocks = blocks;
      if (!resolved(match) && match.status !== 'playing' && !match.started && !match.held) {
        match.status = 'blocked';
        match.blockedReason = qualificationReason(blocks);
      }
    } else {
      delete match.qualificationBlocks;
      if (match.blockedReason?.startsWith('Waiting for qualification:') && !match.held)
        match.blockedReason = null;
    }
  }
  if (changed) state.settings.resourceRevision++;
}
