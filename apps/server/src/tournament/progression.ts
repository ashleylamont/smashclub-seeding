import { decidePoolOrders } from './poolOrders';
import { reconcileRollingFinals, rollingFinals } from './qualifiers';
import { advance } from './brackets';
import { resolveLegacyFinalQualifiers } from './legacyFinalQualifiers';
import { stampReadySince } from './dispatch';
import type { CommandEnvelope, TournamentState } from './schemas';

/** The shared command tail also makes reviewed restoration previews use the
 * exact progression policy that will be persisted on the decision path. */
export function completeCommandProgression(
  previous: TournamentState,
  next: TournamentState,
  envelope: CommandEnvelope,
  basis: Record<string, number>,
) {
  // Scoped removal only deletes an independent draw and releases its frozen field.
  // Keep every surviving pairing and its progression facts exactly as recorded.
  if (envelope.command.kind === 'resetFinals' && envelope.command.scope) return;
  // A reviewed replay applies its exact pool and route changes as one decision.
  if (
    envelope.command.kind === 'replayFinalsSlotV1' ||
    envelope.command.kind === 'replayFinalsRoutesV2'
  )
    return;
  // The original draw and every unaffected pairing already have their recorded state.
  if (
    envelope.command.kind === 'substituteDoublesMember' ||
    envelope.command.kind === 'addLateDoublesPair'
  )
    return;
  decidePoolOrders(previous, next, envelope, basis);
  if (rollingFinals(next) && next.lifecycle === 'locked') {
    reconcileRollingFinals(next, basis);
    advance(next, envelope.at, envelope.id);
  } else if (next.lifecycle === 'locked') {
    const { command } = envelope;
    const poolIds =
      command.kind === 'placements'
        ? [command.poolId]
        : command.kind === 'poolOrders'
          ? command.pools.map(({ poolId }) => poolId)
          : [];
    if (poolIds.length)
      for (const matches of resolveLegacyFinalQualifiers(next, poolIds, basis))
        advance({ ...next, matches }, envelope.at, envelope.id);
  }
  stampReadySince(previous, next, envelope.at);
}
