import { hasFixedLegacyPoolQualifiers } from './legacyFinalQualifiers';
import { canConfirmPoolOrder, plannerPoolOrderBlocker, poolOrderStatus } from './poolOrders';
import { poolFinalsConsumed, rollingFinals } from './qualifiers';
import type { TournamentState } from './schemas';

export type PoolOrderView = {
  poolId: string;
  division: 'upper' | 'lower';
  poolIndex: number;
  status: ReturnType<typeof poolOrderStatus>['status'];
  reason: string;
  plannerConfirmation?: { available: true } | { available: false; reason: string };
};

export function eventPoolOrderViews(state: TournamentState, privateView: boolean): PoolOrderView[] {
  return state.pools.map((pool) => {
    const order = {
      poolId: pool.id,
      division: pool.division,
      poolIndex: pool.index,
      ...poolOrderStatus(state, pool),
    };
    if (
      !privateView ||
      !['locked', 'unlocked'].includes(state.lifecycle) ||
      !['ruling_required', 'partial', 'manual_required'].includes(order.status)
    )
      return order;
    const lockedReason =
      worksheetOrderLock(state, pool, hasFixedLegacyFinals(state, pool.division)) ??
      plannerPoolOrderBlocker(state, pool);
    return {
      ...order,
      plannerConfirmation: lockedReason
        ? { available: false, reason: lockedReason }
        : { available: true },
    };
  });
}

export function hasFixedLegacyFinals(state: TournamentState, division: 'upper' | 'lower') {
  return (
    !state.settings.poolOrderPolicy &&
    !rollingFinals(state) &&
    state.baseline!.structure !== 'round_robin' &&
    state.brackets.some((bracket) => bracket.division === division)
  );
}

export function worksheetOrderLock(
  state: TournamentState,
  pool: TournamentState['pools'][number],
  fixedLegacyFinals: boolean,
) {
  if (fixedLegacyFinals && !canConfirmPoolOrder(state, pool)) {
    if (pool.order)
      return 'The finals draw is in use. Confirmed places stay recorded after withdrawals.';
    if (hasFixedLegacyPoolQualifiers(state, pool))
      return 'The confirmed order is missing. This worksheet cannot restore it after finals used it.';
    return 'This pool order cannot be confirmed while the finals draw is in use.';
  }
  if (pool.qualifierRoster && !pool.qualifierDecision && poolFinalsConsumed(state, pool.id))
    return 'Finals already use this pool order. Called or played opponents and report history stay fixed.';
}
