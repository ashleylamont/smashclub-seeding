import { rollingFinals } from './qualifiers';
import { expectedBracketCount } from '@smashclub/shared';
import { drawFinals } from './brackets';
import { requireFact, resolved } from './facts';
import type { TournamentState, CommandEnvelope } from './schemas';

export function sealResults(next: TournamentState, envelope: CommandEnvelope) {
  if (next.baseline!.structure === 'round_robin' && !next.brackets.length)
    drawFinals(next, envelope);
  requireFact(
    next.brackets.length ===
      expectedBracketCount(next.baseline!.structure, next.baseline!.structureOptions) &&
      next.matches.every(resolved) &&
      (!rollingFinals(next) || next.pools.every((p) => p.order)),
    'Complete the event stages and confirm pool finishing orders first.',
  );
  requireFact(
    next.reports.every((r) => r.status !== 'pending'),
    'Resolve pending reports before finalizing.',
  );
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
  };
  next.lifecycle = 'finalized';
}
