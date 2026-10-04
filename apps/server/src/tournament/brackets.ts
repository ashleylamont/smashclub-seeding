import {
  buildConsolationBracket,
  championshipQualifiers,
  consolationQualifiers,
  standardBracketOrder,
} from '../event-planner/advancement';
import { requireFact, resolved, stableId } from './facts';
import type { CommandEnvelope, TournamentState } from './schemas';

/** Execute advancement once on the decision path; persist resulting matches. */
export function advance(state: TournamentState, at: number, commandId: string) {
  const withdrawn = new Set(
    state.entrants.filter((e) => e.availability === 'withdrawn').map((e) => e.playerId),
  );
  const byId = new Map(state.matches.map((m) => [m.id, m]));
  for (const match of [...state.matches].sort(
    (a, b) => a.round - b.round || a.id.localeCompare(b.id),
  )) {
    if (match.parent1Id && match.parent2Id) {
      const a = byId.get(match.parent1Id)!;
      const b = byId.get(match.parent2Id)!;
      if (!resolved(a) || !resolved(b)) continue;
      const p1 = a.winnerId;
      const p2 = b.winnerId;
      if (p1 !== match.player1Id || p2 !== match.player2Id) {
        requireFact(
          !match.started && !resolved(match),
          'A downstream match already has actual play.',
        );
        Object.assign(match, {
          player1Id: p1,
          player2Id: p2,
          revision: match.revision + 1,
          status: p1 && p2 ? 'ready' : 'blocked',
        });
      }
    }
    if (match.started || resolved(match)) continue;
    const parentsResolved =
      !match.parent1Id ||
      (resolved(byId.get(match.parent1Id)!) && resolved(byId.get(match.parent2Id!)!));
    if (!parentsResolved) continue;
    const players = [match.player1Id, match.player2Id].filter((p): p is string => Boolean(p));
    const remaining = players.filter((p) => !withdrawn.has(p));
    if (remaining.length === 2) {
      match.status = 'ready';
      continue;
    }
    // No game evidence for withdrawals, vacancies, or automatic byes.
    Object.assign(match, {
      status: 'complete',
      outcome: remaining.length === 0 ? 'no_contest' : players.length === 1 ? 'bye' : 'forfeit',
      winnerId: remaining[0] ?? null,
      score1: null,
      score2: null,
      completedAt: at,
      stationId: null,
      revision: match.revision + 1,
      automaticFromRevision: null,
    });
    match.resultCommandId = commandId;
  }
}
export function drawFinals(state: TournamentState, envelope: CommandEnvelope) {
  requireFact(!state.brackets.length, 'Finals have already been drawn.');
  requireFact(
    state.reports.every((r) => r.status !== 'pending'),
    'Resolve pending reports first.',
  );
  requireFact(
    state.matches.every(resolved) && state.pools.every((p) => p.order),
    'Resolve pools and confirm their placements first.',
  );
  for (const division of ['upper', 'lower'] as const) {
    const finishers = state.pools
      .filter((p) => p.division === division)
      .flatMap((p) =>
        p.order!.map((playerId, index) => ({ playerId, poolIndex: p.index, place: index + 1 })),
      );
    for (const stage of ['main', 'consolation'] as const) {
      const qualifiers =
        stage === 'main' ? championshipQualifiers(finishers) : consolationQualifiers(finishers);
      // Reuse the seed-integrity/rematch repair used by current native finals.
      const drawInput =
        stage === 'main'
          ? qualifiers.map((q, index) => ({
              ...q,
              place:
                qualifiers.filter((p, i) => i < index && p.poolIndex === q.poolIndex).length + 3,
            }))
          : qualifiers;
      const entrantIds = drawInput.length
        ? buildConsolationBracket(drawInput).entrants.map((p) => p.playerId)
        : [];
      const bracketId = stableId(`${envelope.id}:${division}:${stage}`);
      state.brackets.push({ id: bracketId, division, stage, entrantIds });
      let size = 2;
      while (size < entrantIds.length) size *= 2;
      const slots = entrantIds.length
        ? standardBracketOrder(size).map((seed) => entrantIds[seed - 1] ?? null)
        : [];
      let previous: string[] = [];
      for (let width = slots.length / 2, round = 1; width >= 1; width /= 2, round++) {
        const current: string[] = [];
        for (let slot = 0; slot < width; slot++) {
          const id = stableId(`${bracketId}:${round}:${slot}`);
          current.push(id);
          const player1Id = round === 1 ? slots[slot * 2]! : null;
          const player2Id = round === 1 ? slots[slot * 2 + 1]! : null;
          state.matches.push({
            id,
            sourceKey: `native:${division}:${stage}:${round}:${slot}`,
            division,
            stage,
            poolId: null,
            bracketId,
            round,
            slot,
            label: `${division} ${stage} · R${round} M${slot + 1}`,
            parent1Id: round === 1 ? null : previous[slot * 2]!,
            parent2Id: round === 1 ? null : previous[slot * 2 + 1]!,
            player1Id,
            player2Id,
            status: player1Id && player2Id ? 'ready' : 'blocked',
            outcome: null,
            score1: null,
            score2: null,
            winnerId: null,
            stationId: null,
            revision: 0,
            started: false,
            completedAt: null,
            automaticFromRevision: null,
            resultCommandId: null,
          });
        }
        previous = current;
      }
    }
  }
  advance(state, envelope.at, envelope.id);
}
