import { requireFact } from './facts';
import { winner } from './scores';
import type { CommandEnvelope, TournamentState } from './schemas';
export function replaceResult(
  state: TournamentState,
  envelope: CommandEnvelope,
  command: Extract<CommandEnvelope['command'], { kind: 'replaceResult' }>,
  basis: Record<string, number>,
) {
  requireFact(
    state.lifecycle === 'finalized' &&
      state.result?.id === command.resultId &&
      state.publication?.resultId === command.resultId,
    'Publish the current sealed revision before replacing it.',
  );
  for (const correction of command.corrections) {
    const m = state.matches.find((m) => m.id === correction.matchId);
    requireFact(
      m && m.revision === correction.expectedRevision && m.outcome !== 'bye',
      'Correction refers to a changed match or automatic bye.',
    );
    basis[m.id] = m.revision;
    // A reviewed post-publication ruling changes result facts, never actual opponents or draws.
    Object.assign(m, correction, {
      winnerId: winner({ ...correction, kind: 'score' }, m),
      revision: m.revision + 1,
      resultCommandId: envelope.id,
      automaticFromRevision: null,
    });
  }
  state.result = {
    ...state.result!,
    id: envelope.id,
    revision: state.result!.revision + 1,
    replacesResultId: command.resultId,
    replacementReason: command.reason,
    sealedAt: envelope.at,
    matches: structuredClone(state.matches),
  };
  state.publication = null;
}
