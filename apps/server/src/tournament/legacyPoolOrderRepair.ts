import { hash, requireFact, resolved } from './facts';
import { hasFixedLegacyPoolQualifiers } from './legacyFinalQualifiers';
import { rollingFinals } from './qualifiers';
import type { TournamentCommand, TournamentDecision, TournamentState } from './schemas';

type Repair = Extract<TournamentCommand, { kind: 'restoreLegacyPoolOrder' }>;
type Evidence = NonNullable<Repair['evidence']>;
type Pool = TournamentState['pools'][number];
type JournalEvent = { id: number; name: string; created: Date };

export const legacyRepairUnavailable =
  'The journal does not verify a complete original order and the withdrawal that cleared it.';

export function canReviewLegacyPoolOrder(state: TournamentState, pool: Pool) {
  return (
    state.baseline?.version === 1 &&
    (!state.baseline.structure || state.baseline.structure === 'dual_division') &&
    !rollingFinals(state) &&
    !pool.order &&
    !pool.orderDecision &&
    !pool.qualifierRoster &&
    !pool.qualifierDecision &&
    hasFixedLegacyPoolQualifiers(state, pool) &&
    ((state.lifecycle === 'locked' && !state.result && !state.publication) ||
      (state.lifecycle === 'finalized' &&
        state.result?.version === 1 &&
        !state.result.poolOrders &&
        state.publication?.resultId === state.result.id))
  );
}

function completeOrder(order: string[] | null, pool: Pool): order is string[] {
  return (
    order !== null &&
    order.length > 0 &&
    order.length === pool.entrantIds.length &&
    new Set(order).size === order.length &&
    order.every((id) => pool.entrantIds.includes(id))
  );
}

function recordedGroupAndDraw(state: TournamentState, pool: Pool) {
  const matches = state.matches.filter(({ poolId }) => poolId === pool.id);
  if (
    !matches.length ||
    !matches.every(resolved) ||
    !pool.entrantIds.every((id) => state.entrants.some(({ playerId }) => playerId === id)) ||
    !hasFixedLegacyPoolQualifiers(state, pool)
  )
    return null;
  return hash({
    entrants: pool.entrantIds,
    matches: matches.map(({ id, player1Id, player2Id, score1, score2, winnerId, outcome }) => ({
      id,
      player1Id,
      player2Id,
      score1,
      score2,
      winnerId,
      outcome,
    })),
    draw: state.brackets
      .filter(({ division }) => division === pool.division)
      .map(({ id, stage, entrantIds }) => ({
        id,
        stage,
        targetSeeds: entrantIds.flatMap((entrantId, seed) =>
          pool.entrantIds.includes(entrantId) ? [[seed, entrantId]] : [],
        ),
      })),
  });
}

function confirmedOrder(decision: TournamentDecision | undefined, poolId: string) {
  const command = decision?.command;
  if (decision?.source !== 'operator') return null;
  if (command?.kind === 'placements' && command.poolId === poolId) return command.order;
  if (command?.kind === 'poolOrders')
    return command.pools.find((pool) => pool.poolId === poolId)?.order ?? null;
  return null;
}

function withdrawnPlayer(decision?: TournamentDecision) {
  const command = decision?.command;
  if (decision?.source !== 'operator') return null;
  if (command?.kind === 'attendance' && command.action === 'withdraw') return command.playerId;
  if (command?.kind === 'availability' && command.availability === 'withdrawn')
    return command.playerId;
  return null;
}

/** Observe only complete, contiguous replays of the exact imported stream. */
export function legacyPoolOrderEvidence(poolId: string) {
  let imported = false;
  let confirmation: Evidence['confirmation'] | null = null;
  let candidate: { evidence: Evidence; facts: string } | null = null;

  function observe(
    event: JournalEvent,
    before: TournamentState,
    after: TournamentState,
    decision?: TournamentDecision,
  ) {
    requireFact(after.sequence === before.sequence + 1, legacyRepairUnavailable);
    if (before.sequence === 0)
      imported = event.name === 'LegacyStateImportedV1' && after.baseline?.version === 1;
    if (!imported) return;

    const pool = after.pools.find(({ id }) => id === poolId);
    if (!pool) {
      confirmation = candidate = null;
      return;
    }
    const previous = before.pools.find(({ id }) => id === poolId);
    if (pool.order) {
      candidate = null;
      if (completeOrder(pool.order, pool) && event.name === 'LegacyStateImportedV1') {
        confirmation = { id: event.id, at: event.created.getTime(), source: 'imported' };
      } else if (
        completeOrder(pool.order, pool) &&
        hash(confirmedOrder(decision, poolId)) === hash(pool.order)
      ) {
        confirmation = { id: event.id, at: event.created.getTime(), source: 'confirmed' };
      } else if (
        hash(previous?.order ?? null) !== hash(pool.order) ||
        !completeOrder(pool.order, pool)
      ) {
        confirmation = null;
      }
    } else if (previous?.order) {
      const playerId = withdrawnPlayer(decision);
      const facts = recordedGroupAndDraw(before, previous);
      candidate =
        confirmation &&
        playerId &&
        completeOrder(previous.order, previous) &&
        previous.entrantIds.includes(playerId) &&
        pool.revision === previous.revision + 1 &&
        before.entrants.some(
          (entrant) => entrant.playerId === playerId && entrant.availability !== 'withdrawn',
        ) &&
        after.entrants.find((entrant) => entrant.playerId === playerId)?.availability ===
          'withdrawn' &&
        facts
          ? {
              facts,
              evidence: {
                order: previous.order,
                confirmation,
                withdrawal: { id: event.id, at: event.created.getTime(), playerId },
              },
            }
          : null;
      confirmation = null;
    }
    if (candidate && recordedGroupAndDraw(after, pool) !== candidate.facts) candidate = null;
  }

  return {
    observe,
    forPool(state: TournamentState, pool: Pool) {
      return candidate && recordedGroupAndDraw(state, pool) === candidate.facts
        ? candidate.evidence
        : null;
    },
  };
}

export function legacyRepairToken(state: TournamentState, pool: Pool, evidence: Evidence) {
  return hash({
    planId: state.baseline!.planId,
    poolId: pool.id,
    sequence: state.sequence,
    revision: pool.revision,
    evidence,
  });
}

export function restoreLegacyPoolOrder(
  state: TournamentState,
  command: Repair,
  basis: Record<string, number>,
) {
  const pool = state.pools.find(({ id }) => id === command.poolId);
  requireFact(
    state.sequence === command.expectedSequence && pool?.revision === command.expectedPoolRevision,
    'The event changed since this review. Check the journal again.',
  );
  requireFact(
    pool &&
      canReviewLegacyPoolOrder(state, pool) &&
      command.evidence &&
      completeOrder(command.evidence.order, pool) &&
      legacyRepairToken(state, pool, command.evidence) === command.revisionToken,
    legacyRepairUnavailable,
  );
  basis[pool.id] = pool.revision;
  pool.order = [...command.evidence.order];
  pool.revision++;
}
