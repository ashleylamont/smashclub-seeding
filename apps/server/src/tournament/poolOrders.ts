import {
  rollingFinals,
  requirePoolCorrectionAllowed,
  qualifierGroups,
  strengthFinalsUsePool,
} from './qualifiers';
import { hash, requireFact, resolved } from './facts';
import { hasCurrentPendingScoreReview } from './scoreReview';
import { hasLegacyQualifier } from './legacyFinalQualifiers';
import type { CommandEnvelope, TournamentCommand, TournamentState } from './schemas';

type Pool = TournamentState['pools'][number];
export const POOL_ORDER_ENTRANT_LIMITS = { min: 2, max: 16 } as const;

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
  if (
    pool.order &&
    pool.orderDecision &&
    pool.orderDecision.resultBasis !== poolResultBasis(state, pool)
  )
    return {
      status: 'retained_after_correction' as const,
      reason:
        'A reviewed result correction changed this pool. Its recorded order and finals qualifiers remain fixed.',
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
  if (pool.qualifierRoster && qualifierGroups(pool).some((group) => group.length === 1))
    return {
      status: 'partial' as const,
      reason: 'Set wins decide the clear places. Confirm a ruling for the tied places.',
    };
  if (setWinGroups(state, pool, matches)?.length !== pool.entrantIds.length)
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

/** Rank bands use official set wins alone. Array order inside a tie carries no rank. */
function setWinGroups(
  state: TournamentState,
  pool: Pool,
  matches: TournamentState['matches'],
): string[][] | null {
  const wins = new Map(pool.entrantIds.map((id) => [id, 0]));
  for (const m of matches) {
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
  const byWins = new Map<number, string[]>();
  for (const [id, total] of wins) {
    const group = byWins.get(total);
    if (group) group.push(id);
    else byWins.set(total, [id]);
  }
  return [...byWins].sort(([a], [b]) => b - a).map(([, group]) => group);
}

type ResultEvidence = Omit<NonNullable<Pool['qualifierDecision']>, 'policy' | 'groups'>;

export function poolOrderEvidence(
  state: TournamentState,
  pool: Pool,
  envelope: CommandEnvelope,
  matches = matchesFor(state, pool),
): ResultEvidence {
  return {
    resultBasis: poolResultBasis(state, pool),
    matchRevisions: Object.fromEntries(matches.map(({ id, revision }) => [id, revision])),
    commandId: envelope.id,
    decidedAt: envelope.at,
  };
}

function automaticOrder(pool: Pool, groups: string[][] | null) {
  return groups?.length === pool.entrantIds.length ? groups.flat() : null;
}

function sameAutomaticOrder(pool: Pool, order: string[] | null) {
  const original = pool.orderDecision;
  return (
    original?.source === 'automatic' &&
    order !== null &&
    original.order.length === order.length &&
    original.order.every((id, index) => id === order[index])
  );
}

export function automaticPoolOrder(state: TournamentState, pool: Pool) {
  return automaticOrder(pool, setWinGroups(state, pool, matchesFor(state, pool)));
}

export function canReviewFrozenPoolResult(state: TournamentState, pool: Pool) {
  if (
    state.lifecycle !== 'locked' ||
    state.settings.poolOrderPolicy !== 'unique_set_wins_v1' ||
    !rollingFinals(state) ||
    !pool.order ||
    !pool.qualifierRoster ||
    pool.qualifierDecision ||
    !strengthFinalsUsePool(state, pool.id)
  )
    return false;
  const matches = matchesFor(state, pool);
  return (
    sameAutomaticOrder(pool, automaticOrder(pool, setWinGroups(state, pool, matches))) &&
    hash(pool.order) === hash(pool.orderDecision!.order) &&
    !matches.some((match) => hasCurrentPendingScoreReview(match, state.reports))
  );
}

function decideQualifierBands(
  groups: string[][] | null,
  old: Pool['qualifierDecision'],
  evidence: ResultEvidence,
  pending: boolean,
) {
  if (!groups) return;
  if (old?.resultBasis === evidence.resultBasis) return old;
  if (!pending) return { policy: 'set_win_bands_v1' as const, groups, ...evidence };
}

/** Runs only while deciding a new opted-in command. Replay folds persisted facts. */
export function decidePoolOrders(
  previous: TournamentState,
  next: TournamentState,
  envelope: CommandEnvelope,
  basis: Record<string, number>,
) {
  if (
    !next.settings.poolOrderPolicy ||
    (next.brackets.length && !rollingFinals(next)) ||
    next.lifecycle !== 'locked'
  )
    return;
  for (const pool of next.pools) {
    const old = previous.pools.find((p) => p.id === pool.id);
    const matches = matchesFor(next, pool);
    const evidence = poolOrderEvidence(next, pool, envelope, matches);
    const { resultBasis } = evidence;
    const explicit =
      envelope.command.kind === 'placements'
        ? envelope.command.poolId === pool.id
        : envelope.command.kind === 'poolOrders' &&
          envelope.command.pools.some((p) => p.poolId === pool.id);
    const pending = matches.some((m) => hasCurrentPendingScoreReview(m, next.reports));
    // Keep a manual ruling through harmless confirmations and suspended reviews.
    // An actual result/roster change makes its evidence stale.
    requireFact(
      !explicit || !pending,
      'Resolve current score reports before confirming pool placements.',
    );
    const groups = setWinGroups(next, pool, matches);
    const automatic = automaticOrder(pool, groups);
    const retainsFrozenOrder =
      old && strengthFinalsUsePool(next, pool.id) && sameAutomaticOrder(old, automatic);
    const retained =
      (old?.orderDecision?.resultBasis === resultBasis &&
        (old.orderDecision.source === 'manual' || automatic)) ||
      retainsFrozenOrder
        ? old.orderDecision
        : old?.order && !old.orderDecision && poolResultBasis(previous, old) === resultBasis
          ? {
              source: 'manual' as const,
              policy: next.settings.poolOrderPolicy,
              order: old.order,
              ...evidence,
            }
          : undefined;
    const order = pending ? null : explicit ? pool.order : (retained?.order ?? automatic);
    const decision =
      explicit && order
        ? {
            source: 'manual' as const,
            policy: next.settings.poolOrderPolicy,
            order,
            ...evidence,
          }
        : (retained ??
          (order
            ? {
                source: 'automatic' as const,
                policy: next.settings.poolOrderPolicy,
                order,
                ...evidence,
              }
            : undefined));
    const qualifierDecision =
      rollingFinals(next) && !decision && !automatic
        ? decideQualifierBands(groups, old?.qualifierDecision, evidence, pending)
        : undefined;
    if (
      hash(pool.qualifierDecision ?? null) !== hash(qualifierDecision ?? null) ||
      hash(pool.order) !== hash(order) ||
      hash(pool.orderDecision ?? null) !== hash(decision ?? null)
    ) {
      basis[pool.id] = old?.revision ?? pool.revision;
      for (const m of matches)
        basis[m.id] ??= previous.matches.find((p) => p.id === m.id)?.revision ?? m.revision;
      pool.order = order;
      if (decision) pool.orderDecision = decision;
      else delete pool.orderDecision;
      if (qualifierDecision) pool.qualifierDecision = qualifierDecision;
      else delete pool.qualifierDecision;
      // Existing score/attendance paths may already have invalidated this version.
      if (pool.revision === old?.revision) pool.revision++;
    }
  }
}

/** Public status contains no command references, fingerprints or report details. */
export function publicPoolViews(state: TournamentState) {
  return state.pools.map((pool) => {
    const orderStatus = poolOrderStatus(state, pool);
    const { orderDecision: _order, qualifierDecision: _qualifiers, ...publicPool } = pool;
    return { ...publicPool, orderStatus };
  });
}

export function poolPlacementSource(state: TournamentState, pool: Pool) {
  return pool.orderDecision && pool.orderDecision.resultBasis !== poolResultBasis(state, pool)
    ? ('retained' as const)
    : (pool.orderDecision?.source ?? 'manual');
}

/** Explicit post-publication round-robin rulings supersede automatic evidence. */
export function recordReplacementPoolOrder(state: TournamentState, envelope: CommandEnvelope) {
  if (!state.settings.poolOrderPolicy) return;
  const pool = state.pools[0]!;
  pool.orderDecision = {
    source: 'manual',
    policy: state.settings.poolOrderPolicy,
    order: [...pool.order!],
    ...poolOrderEvidence(state, pool, envelope),
  };
  pool.revision++;
}

export function canConfirmPoolOrder(state: TournamentState, pool: Pool) {
  return (
    !state.brackets.length ||
    rollingFinals(state) ||
    (!pool.order && hasLegacyQualifier(state, pool.id, 'pending'))
  );
}

/** Additional confirmation limits on the planner's normal write path. */
export function plannerPoolOrderBlocker(state: TournamentState, pool: Pool) {
  const { min, max } = POOL_ORDER_ENTRANT_LIMITS;
  const count = pool.entrantIds.length;
  if (count < min || count > max)
    return `This pool has ${count} ${count === 1 ? 'entrant' : 'entrants'}. The planner can confirm orders for pools of ${min}–${max} entrants.`;
  if (state.lifecycle === 'unlocked') return 'Relock the draw before confirming this pool order.';
  if (!canConfirmPoolOrder(state, pool))
    return 'This pool order cannot be confirmed while the finals draw is in use.';
}

export function confirmPoolPlacements(
  state: TournamentState,
  command: Extract<TournamentCommand, { kind: 'placements' }>,
  basis: Record<string, number>,
) {
  const pool = state.pools.find((p) => p.id === command.poolId);
  requireFact(
    pool && pool.revision === command.expectedRevision && canConfirmPoolOrder(state, pool),
    'Pool placements changed or finals already exist.',
  );
  requireFact(
    command.order.length === pool.entrantIds.length &&
      new Set(command.order).size === pool.entrantIds.length &&
      command.order.every((id) => pool.entrantIds.includes(id)),
    'Placements must contain each pool entrant exactly once.',
  );
  const matches = state.matches.filter((m) => m.poolId === pool.id);
  requireFact(
    matches.every((m) => resolved(m) && command.matchRevisions[m.id] === m.revision),
    'Resolve and review current pool results.',
  );
  basis[pool.id] = pool.revision;
  for (const m of matches) basis[m.id] = m.revision;
  requirePoolOrderChangeAllowed(state, pool, command.order);
  pool.order = command.order;
  pool.revision++;
}

/** A first tie ruling can complete the order after finals consume a clear place.
 * Every band must retain its entrants, which also protects compressed frozen places.
 * Before finals reserve the field, organisers can still record a full order. */
export function requirePoolOrderChangeAllowed(state: TournamentState, pool: Pool, order: string[]) {
  if (!rollingFinals(state) || !pool.qualifierRoster || hash(pool.order) === hash(order)) return;
  if (pool.order || !pool.qualifierDecision) {
    requirePoolCorrectionAllowed(state, pool.id);
    return;
  }
  let offset = 0;
  for (const group of pool.qualifierDecision.groups) {
    requireFact(
      order.slice(offset, offset + group.length).every((id) => group.includes(id)),
      'A tie ruling can only change places within the same set-win group.',
    );
    offset += group.length;
  }
}
