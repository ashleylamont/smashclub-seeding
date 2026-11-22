import { rollingFinals } from './qualifiers';
import { expectedBracketCount, isKnockout } from '@smashclub/shared';
import { drawFinals } from './brackets';
import { requireFact, resolved } from './facts';
import type { TournamentState, CommandEnvelope } from './schemas';

const createsRoundRobinResult = (state: TournamentState) =>
  state.baseline!.structure === 'round_robin' && !state.brackets.length;

/** Used by the organiser's desk and by the protected finalize decision. */
export function finalizationBlocker(state: TournamentState) {
  if (state.reports.some((report) => report.status === 'pending'))
    return {
      kind: 'pending_reports',
      message: 'Resolve pending reports before finalizing.',
    } as const;

  const { structure, structureOptions } = state.baseline!;
  const roundRobinResult = createsRoundRobinResult(state);
  const unfinished = state.matches.filter((match) => !resolved(match));
  const missingOrder =
    (roundRobinResult || rollingFinals(state)) && state.pools.find((pool) => !pool.order);
  if (missingOrder && !unfinished.some((match) => match.poolId))
    return {
      kind: 'pool_order',
      poolId: missingOrder.id,
      message: 'Confirm the remaining pool finishing order before publishing results.',
    } as const;

  if (
    !roundRobinResult &&
    state.brackets.length !== expectedBracketCount(structure, structureOptions)
  )
    return isKnockout(structure) || structure === 'round_robin'
      ? ({ kind: 'draw_invalid', message: 'The event draw is incomplete.' } as const)
      : ({
          kind: 'missing_draw',
          message: 'Create the missing finals draws before publishing results.',
        } as const);

  const nextMatch =
    unfinished.find(({ status }) => status === 'playing' || status === 'ready') ?? unfinished[0];
  if (nextMatch)
    return {
      kind: 'unfinished_matches',
      matchId: nextMatch.id,
      message: 'Finish the remaining matches before publishing results.',
    } as const;

  const archived = state.supersededPlayedSets ?? [];
  if (!archived.length) return null;
  const active = new Map(state.matches.map((match) => [match.id, match]));
  const bracketIds = new Set(state.brackets.map(({ id }) => id));
  const replacements = new Set(archived.map(({ replacementMatchId }) => replacementMatchId));
  const originalIds = new Set(archived.map(({ match }) => match.id));
  const archiveValid =
    archived.length === replacements.size &&
    archived.length === originalIds.size &&
    archived.every(
      ({ match, replacementMatchId }) =>
        match.bracketId &&
        bracketIds.has(match.bracketId) &&
        match.outcome === 'played' &&
        !match.skipped &&
        !active.has(match.id) &&
        active.get(replacementMatchId)?.bracketId === match.bracketId,
    );
  if (!archiveValid)
    return {
      kind: 'replay_invalid',
      message: 'Review the recorded finals replay before sealing its results.',
    } as const;
  return null;
}

export function sealResults(next: TournamentState, envelope: CommandEnvelope) {
  const blocker = finalizationBlocker(next);
  if (blocker) requireFact(false, blocker.message);
  if (createsRoundRobinResult(next)) drawFinals(next, envelope);
  const archived = next.supersededPlayedSets ?? [];
  next.result = {
    version: next.baseline!.version,
    ...(next.baseline!.version === 2
      ? {
          competitionFormat: next.baseline!.competitionFormat,
          structure: next.baseline!.structure,
          structureOptions: next.baseline!.structureOptions,
          poolOrders: next.pools.map((p) => ({ division: p.division, order: p.order ?? [] })),
        }
      : {}),
    id: envelope.id,
    planId: next.baseline!.planId,
    revision: 1,
    name: next.baseline!.name,
    eventDate: next.baseline!.eventDate,
    sealedAt: envelope.at,
    replacesResultId: null,
    replacementReason: null,
    entrants: structuredClone(next.entrants),
    brackets: structuredClone(next.brackets),
    matches: structuredClone(next.matches),
    ...(archived.length ? { supersededPlayedSets: structuredClone(archived) } : {}),
  };
  next.lifecycle = 'finalized';
}
