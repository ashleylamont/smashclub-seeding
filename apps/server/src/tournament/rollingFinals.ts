import { buildEliminationTree, buildFormatFinals } from '@smashclub/engine';
import { finalsRoles } from '@smashclub/shared';
import { instantiateElimination } from './structureAdapter';
import { qualificationPlaces, reconcileRollingFinals } from './qualifiers';
import { stableId } from './facts';
import type { CommandEnvelope, QualifierSlot, StrengthSeeding, TournamentState } from './schemas';

export function eligibleQualifierRoster(
  state: TournamentState,
  pool: TournamentState['pools'][number],
) {
  return (
    pool.qualifierRoster ??
    pool.entrantIds.filter(
      (id) =>
        !state.entrants.some(
          (entrant) => entrant.playerId === id && entrant.availability === 'withdrawn',
        ),
    )
  );
}

export function appendQualifierBracket(
  state: TournamentState,
  envelope: CommandEnvelope,
  division: 'upper' | 'lower',
  stage: 'main' | 'consolation',
  slots: QualifierSlot[],
  strengthSeeding?: StrengthSeeding,
) {
  const bracketId = stableId(`${envelope.id}:${division}:${stage}`);
  state.brackets.push({
    id: bracketId,
    division,
    stage,
    entrantIds: slots.flatMap((source) => (source.entrantId ? [source.entrantId] : [])),
    qualifierSlots: slots,
    ...(strengthSeeding ? { strengthSeeding } : {}),
  });
  const tree = buildEliminationTree(
    bracketId,
    slots.map((source) => ({
      kind: 'pool_place',
      poolId: source.poolId,
      place: source.place,
    })),
  );
  state.matches.push(...instantiateElimination(tree, bracketId, division, stage, slots));
}

/** Reserve the complete chosen field once. Later withdrawals affect availability
 * and forfeits, never its qualification cut, seed policy or bracket geometry. */
export function drawRollingFinals(state: TournamentState, envelope: CommandEnvelope) {
  for (const pool of state.pools) {
    pool.qualifierRoster = eligibleQualifierRoster(state, pool);
    pool.revision++;
  }
  const divisions =
    state.baseline!.structure && state.baseline!.structure !== 'dual_division'
      ? (['upper'] as const)
      : (['upper', 'lower'] as const);
  for (const division of divisions) {
    const sources = new Map<string, QualifierSlot>();
    const finishers = state.pools
      .filter((p) => p.division === division)
      .flatMap((pool) => {
        const places = qualificationPlaces(state, pool);
        return pool.qualifierRoster!.map((_, index) => {
          const place = index + 1;
          const playerId = stableId(`${pool.id}:qualifier:${place}`);
          sources.set(playerId, {
            poolId: pool.id,
            poolIndex: pool.index,
            division,
            place,
            eligibleEntrantIds: [...pool.qualifierRoster!],
            ...places[index]!,
          });
          return { playerId, poolIndex: pool.index, place };
        });
      });
    for (const stage of finalsRoles(state.baseline!.structure, state.baseline!.structureOptions)) {
      const slots = buildFormatFinals(
        state.baseline!.structure,
        finishers,
        stage,
        state.baseline!.structureOptions,
      ).map((q) => sources.get(q.playerId)!);
      appendQualifierBracket(state, envelope, division, stage, slots);
    }
  }
  reconcileRollingFinals(state, {});
  state.settings.resourceRevision++;
}
