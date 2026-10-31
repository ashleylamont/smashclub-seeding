import { buildEliminationTree, buildFormatFinals } from '@smashclub/engine';
import { finalsRoles } from '@smashclub/shared';
import { instantiateElimination } from './structureAdapter';
import { qualificationStatus, reconcileRollingFinals } from './qualifiers';
import { stableId } from './facts';
import type { CommandEnvelope, QualifierSlot, TournamentState } from './schemas';

/** Reserve the complete chosen field once. Later withdrawals affect availability
 * and forfeits, never its qualification cut, seed policy or bracket geometry. */
export function drawRollingFinals(state: TournamentState, envelope: CommandEnvelope) {
  for (const pool of state.pools) {
    pool.qualifierRoster = pool.entrantIds.filter(
      (id) => !state.entrants.some((e) => e.playerId === id && e.availability === 'withdrawn'),
    );
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
      .flatMap((pool) =>
        pool.qualifierRoster!.map((_, index) => {
          const place = index + 1;
          const playerId = stableId(`${pool.id}:qualifier:${place}`);
          const status = qualificationStatus(state, pool.id);
          sources.set(playerId, {
            poolId: pool.id,
            poolIndex: pool.index,
            division,
            place,
            status,
            eligibleEntrantIds: [...pool.qualifierRoster!],
            entrantId:
              status === 'resolved'
                ? pool.order!.filter((id) => pool.qualifierRoster!.includes(id))[index]!
                : null,
          });
          return { playerId, poolIndex: pool.index, place };
        }),
      );
    for (const stage of finalsRoles(state.baseline!.structure, state.baseline!.structureOptions)) {
      const slots = buildFormatFinals(
        state.baseline!.structure,
        finishers,
        stage,
        state.baseline!.structureOptions,
      ).map((q) => sources.get(q.playerId)!);
      const bracketId = stableId(`${envelope.id}:${division}:${stage}`);
      state.brackets.push({
        id: bracketId,
        division,
        stage,
        entrantIds: slots.flatMap((source) => (source.entrantId ? [source.entrantId] : [])),
        qualifierSlots: slots,
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
  }
  reconcileRollingFinals(state, {});
  state.settings.resourceRevision++;
}
