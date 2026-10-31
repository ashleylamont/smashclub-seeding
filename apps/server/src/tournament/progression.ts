import { decidePoolOrders } from './poolOrders';
import { reconcileRollingFinals, rollingFinals } from './qualifiers';
import { advance } from './brackets';
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
  decidePoolOrders(previous, next, envelope, basis);
  if (rollingFinals(next) && next.lifecycle === 'locked') {
    reconcileRollingFinals(next, basis);
    advance(next, envelope.at, envelope.id);
  }
  stampReadySince(previous, next, envelope.at);
}
