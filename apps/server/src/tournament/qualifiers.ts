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
export function qualificationStatus(state: TournamentState, poolId: string) {
  const pool = state.pools.find((p) => p.id === poolId)!;
  if (
    state.matches.some((m) => m.poolId === poolId && hasCurrentPendingScoreReview(m, state.reports))
  )
    return 'review_pending' as const;
  return pool.order ? ('resolved' as const) : ('pending' as const);
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
export function qualifierDependencies(state: TournamentState, match: Match): QualifierSource[] {
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
  return state.matches.some(
    (m) =>
      m.bracketId &&
      protectedMatch(state, m) &&
      qualifierDependencies(state, m).some((source) => source.poolId === poolId),
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
  for (const bracket of state.brackets) {
    if (!bracket.qualifierSlots) continue;
    for (const slot of bracket.qualifierSlots) {
      const before = hash(slot);
      const pool = state.pools.find((p) => p.id === slot.poolId)!;
      const status = qualificationStatus(state, pool.id);
      const selected =
        status === 'resolved'
          ? (pool.order!.filter((id) => pool.qualifierRoster!.includes(id))[slot.place - 1] ?? null)
          : null;
      if (status === 'resolved') {
        requireFact(selected, 'The finishing order no longer fills its frozen qualifier field.');
        requireFact(
          !consumed.get(pool.id) || !slot.entrantId || slot.entrantId === selected,
          'A qualifier change would rewrite a called or played finals route.',
        );
      }
      slot.status = status;
      if (status === 'resolved' || !consumed.get(pool.id)) slot.entrantId = selected;
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
