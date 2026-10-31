import { hash, requireFact, resolved } from './facts';
import { hasCurrentPendingScoreReview } from './scoreReview';
import type { CommandEnvelope, TournamentState } from './schemas';

type Pool = TournamentState['pools'][number];
const matchesFor = (state: TournamentState, pool: Pool) =>
  state.matches.filter((m) => m.poolId === pool.id);

/** Result evidence deliberately excludes reporting/call revisions and availability.
 * Recorded orders contain every entrant; native qualification separately filters
 * withdrawn entrants and compresses the active finishing places. */
export function poolResultBasis(state: TournamentState, pool: Pool) {
  return hash({
    entrantIds: pool.entrantIds,
    results: matchesFor(state, pool).map((m) => ({
      id: m.id,
      player1Id: m.player1Id,
      player2Id: m.player2Id,
      status: resolved(m) ? 'complete' : 'unresolved',
      outcome: m.outcome,
      winnerId: m.winnerId,
      score1: m.score1,
      score2: m.score2,
    })),
  });
}

export function poolOrderStatus(state: TournamentState, pool: Pool) {
  const matches = matchesFor(state, pool);
  if (matches.some((m) => hasCurrentPendingScoreReview(m, state.reports)))
    return {
      status: 'review_pending' as const,
      reason: 'Resolve current score reports before deciding this pool order.',
    };
  if (pool.order)
    return pool.orderDecision?.source === 'automatic'
      ? {
          status: 'automatic' as const,
          reason: 'Decided automatically by distinct set-win totals, including forfeits.',
        }
      : { status: 'manual' as const, reason: 'Finishing order confirmed by an organiser.' };
  if (matches.some((m) => !resolved(m)))
    return {
      status: 'incomplete' as const,
      reason: 'Complete every pool match, including explicit withdrawal forfeits.',
    };
  if (!state.settings.poolOrderPolicy)
    return {
      status: 'manual_required' as const,
      reason: 'This event uses organiser-confirmed pool orders.',
    };
  if (!uniqueSetWinOrder(state, pool))
    return {
      status: 'ruling_required' as const,
      reason:
        'Set wins do not decide a unique full order. Confirm an organiser ruling; no game-difference or head-to-head tiebreak is applied.',
    };
  return {
    status: 'manual_required' as const,
    reason: 'Confirm the pool order before proceeding.',
  };
}

/** Conservative V1 policy: no games, rating input, or implicit tie breaker. */
function uniqueSetWinOrder(state: TournamentState, pool: Pool): string[] | null {
  const wins = new Map(pool.entrantIds.map((id) => [id, 0]));
  for (const m of matchesFor(state, pool)) {
    if (!resolved(m)) return null;
    if (m.outcome === 'no_contest') {
      if (
        m.winnerId ||
        m.score1 !== null ||
        m.score2 !== null ||
        ![m.player1Id, m.player2Id].every((id) =>
          state.entrants.some((e) => e.playerId === id && e.availability === 'withdrawn'),
        )
      )
        return null;
    } else {
      if (
        !['played', 'forfeit'].includes(m.outcome ?? '') ||
        !m.winnerId ||
        ![m.player1Id, m.player2Id].includes(m.winnerId) ||
        !wins.has(m.winnerId)
      )
        return null;
      wins.set(m.winnerId, wins.get(m.winnerId)! + 1);
    }
  }
  if (new Set(wins.values()).size !== pool.entrantIds.length) return null;
  return [...pool.entrantIds].sort((a, b) => wins.get(b)! - wins.get(a)!);
}

/** Runs only while deciding a new opted-in command. Replay folds persisted facts. */
export function decidePoolOrders(
  previous: TournamentState,
  next: TournamentState,
  envelope: CommandEnvelope,
  basis: Record<string, number>,
) {
  if (!next.settings.poolOrderPolicy || next.brackets.length || next.lifecycle !== 'locked') return;
  for (const pool of next.pools) {
    const old = previous.pools.find((p) => p.id === pool.id);
    const resultBasis = poolResultBasis(next, pool);
    const explicit =
      envelope.command.kind === 'placements'
        ? envelope.command.poolId === pool.id
        : envelope.command.kind === 'poolOrders' &&
          envelope.command.pools.some((p) => p.poolId === pool.id);
    const matches = matchesFor(next, pool);
    const pending = matches.some((m) => hasCurrentPendingScoreReview(m, next.reports));
    // Keep a manual ruling through harmless confirmations and suspended reviews.
    // An actual result/roster change makes its evidence stale.
    requireFact(
      !explicit || !pending,
      'Resolve current score reports before confirming pool placements.',
    );
    const automatic = uniqueSetWinOrder(next, pool);
    const retained =
      old?.orderDecision?.resultBasis === resultBasis &&
      (old.orderDecision.source === 'manual' || automatic)
        ? old.orderDecision
        : old?.order && !old.orderDecision && poolResultBasis(previous, old) === resultBasis
          ? {
              source: 'manual' as const,
              policy: next.settings.poolOrderPolicy,
              order: old.order,
              resultBasis,
              matchRevisions: Object.fromEntries(matches.map((m) => [m.id, m.revision])),
              commandId: envelope.id,
              decidedAt: envelope.at,
            }
          : undefined;
    const order = pending ? null : explicit ? pool.order : (retained?.order ?? automatic);
    const decision =
      explicit && order
        ? {
            source: 'manual' as const,
            policy: next.settings.poolOrderPolicy,
            order,
            resultBasis,
            matchRevisions: Object.fromEntries(matches.map((m) => [m.id, m.revision])),
            commandId: envelope.id,
            decidedAt: envelope.at,
          }
        : (retained ??
          (order
            ? {
                source: 'automatic' as const,
                policy: next.settings.poolOrderPolicy,
                order,
                resultBasis,
                matchRevisions: Object.fromEntries(matches.map((m) => [m.id, m.revision])),
                commandId: envelope.id,
                decidedAt: envelope.at,
              }
            : undefined));
    if (
      hash(pool.order) !== hash(order) ||
      hash(pool.orderDecision ?? null) !== hash(decision ?? null)
    ) {
      basis[pool.id] = old?.revision ?? pool.revision;
      for (const m of matches)
        basis[m.id] ??= previous.matches.find((p) => p.id === m.id)?.revision ?? m.revision;
      pool.order = order;
      if (decision) pool.orderDecision = decision;
      else delete pool.orderDecision;
      // Existing score/attendance paths may already have invalidated this version.
      if (pool.revision === old?.revision) pool.revision++;
    }
  }
}

/** Public status contains no command references, fingerprints or report details. */
export function publicPoolViews(state: TournamentState) {
  return state.pools.map(({ orderDecision: _decision, ...pool }) => ({
    ...pool,
    orderStatus: poolOrderStatus(state, pool),
  }));
}
