import { finalsRoles } from '@smashclub/shared';
import { selectFormatFinalists } from '@smashclub/tournament-formats';
import { hash, requireFact, TournamentConflict } from './facts';
import { automaticPoolOrder, poolOrderEvidence } from './poolOrders';
import { poolFinalsConsumed, sourceDescriptor } from './qualifiers';
import { hasCurrentPendingScoreReview } from './scoreReview';
import type { CommandEnvelope, TournamentState } from './schemas';

type Pool = TournamentState['pools'][number];
type Bracket = TournamentState['brackets'][number];

function exactBracketSources(state: TournamentState, bracket: Bracket) {
  const routes = state.matches
    .filter((match) => match.bracketId === bracket.id)
    .flatMap((match) =>
      ([1, 2] as const).flatMap((side) => {
        const source = match[`player${side}Qualifier`];
        return source
          ? [{ source, entrantId: match[`player${side}Id`], parentId: match[`parent${side}Id`] }]
          : [];
      }),
    );
  return (
    routes.length === bracket.qualifierSlots?.length &&
    bracket.qualifierSlots.every(
      (slot) =>
        routes.filter(
          ({ source, entrantId, parentId }) =>
            !parentId &&
            entrantId === slot.entrantId &&
            hash(source) === hash(sourceDescriptor(slot)),
        ).length === 1,
    )
  );
}

function recordedPlayoffPool(before: TournamentState) {
  const baseline = before.baseline;
  const [pool] = before.pools;
  requireFact(
    baseline?.structure === 'round_robin_finals' &&
      pool &&
      before.pools.length === 1 &&
      pool.order &&
      !pool.qualifierDecision &&
      pool.orderDecision?.source === 'automatic' &&
      hash(pool.orderDecision.order) === hash(pool.order) &&
      hash(automaticPoolOrder(before, pool)) === hash(pool.order),
    'This correction requires the recorded automatic pool order to match the current results.',
  );
  const matches = before.matches.filter((match) => match.poolId === pool.id);
  requireFact(
    matches.every((match) => !hasCurrentPendingScoreReview(match, before.reports)),
    'Resolve current pool score reports before correcting the finishing order.',
  );
  const exactEvidence = 'This correction requires exact recorded finals qualification sources.';
  requireFact(pool.qualifierRoster, exactEvidence);
  const roster = new Set(pool.qualifierRoster);
  const oldField = pool.order.filter((id) => roster.has(id));
  requireFact(
    roster.size === pool.qualifierRoster.length && oldField.length === roster.size,
    exactEvidence,
  );
  const finishers = oldField.map((playerId, index) => ({
    playerId,
    poolIndex: pool.index,
    place: index + 1,
  }));
  const { structure, structureOptions } = baseline;
  const roles = finalsRoles(structure, structureOptions);
  requireFact(before.brackets.length === roles.length, exactEvidence);
  if (before.result)
    requireFact(
      hash(before.result.brackets) === hash(before.brackets) &&
        hash(before.result.poolOrders ?? null) ===
          hash([{ division: pool.division, order: pool.order }]),
      exactEvidence,
    );
  const frozenSlots = roles.flatMap((stage) => {
    const bracket = before.brackets.find(
      (item) => item.stage === stage && item.division === pool.division,
    );
    const slots = bracket?.qualifierSlots;
    const selected = selectFormatFinalists(structure, finishers, stage, structureOptions);
    requireFact(
      bracket &&
        slots &&
        selected.length === slots.length &&
        hash(bracket.entrantIds) === hash(slots.map(({ entrantId }) => entrantId)) &&
        selected.every(({ place, playerId }) =>
          slots.some(
            (slot) =>
              slot.poolId === pool.id &&
              slot.poolIndex === pool.index &&
              slot.division === pool.division &&
              slot.place === place &&
              slot.status === 'resolved' &&
              slot.entrantId === playerId &&
              !slot.candidateEntrantIds &&
              hash(slot.eligibleEntrantIds) === hash(pool.qualifierRoster),
          ),
        ) &&
        exactBracketSources(before, bracket),
      exactEvidence,
    );
    return slots;
  });
  return { pool, matches, roster, frozenSlots };
}

/** Only offer the dedicated review once the ordinary score path protects the draw. */
export function reviewablePlayoffPoolId(state: TournamentState) {
  const [pool] = state.pools;
  if (
    state.lifecycle !== 'locked' ||
    state.baseline?.structure !== 'round_robin_finals' ||
    !pool ||
    !poolFinalsConsumed(state, pool.id)
  )
    return;
  try {
    return recordedPlayoffPool(state).pool.id;
  } catch (error) {
    if (!(error instanceof TournamentConflict)) throw error;
  }
}

export function reviewPlayoffPoolOrder(before: TournamentState, corrected: TournamentState) {
  const { pool, matches, roster, frozenSlots } = recordedPlayoffPool(before);
  const order = automaticPoolOrder(corrected, pool);
  requireFact(order, 'The corrected results need a separate ruling for the pool order.');
  const newField = order.filter((id) => roster.has(id));
  requireFact(
    frozenSlots.every((slot) => newField[slot.place - 1] === slot.entrantId),
    'The correction would change a recorded finals qualification assignment.',
  );
  return { pool, matches, order };
}

export function recordPlayoffPoolOrder(
  state: TournamentState,
  pool: Pool,
  order: string[],
  envelope: CommandEnvelope,
) {
  pool.order = order;
  pool.revision++;
  pool.orderDecision = {
    source: 'automatic',
    policy: 'unique_set_wins_v1',
    order,
    ...poolOrderEvidence(state, pool, envelope),
  };
}
