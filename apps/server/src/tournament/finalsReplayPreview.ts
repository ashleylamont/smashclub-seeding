import { randomUUID } from 'node:crypto';
import { decide, reduceDecision, TournamentConflict } from './domain';
import { reviewFinalsSlotReplay, type ReplayScore } from './finalsSlotReplay';
import type { TournamentState } from './schemas';

export function previewFinalsSlotReplay(
  state: TournamentState,
  score: ReplayScore,
  reviewVersion: 1 | 2 = 1,
) {
  const review = reviewFinalsSlotReplay(state, score, reviewVersion);
  if (!('returnCallCandidate' in review) || !review.returnCallCandidate) return review.preview;
  const call = state.matches.find(({ id }) => id === review.returnCallCandidate);
  if (!call || state.lifecycle !== 'locked') return review.preview;

  // Use the actual Return command and replay guards on a disposable state.
  // The operator still has to return the call and review the real state again.
  const id = randomUUID();
  try {
    const decision = decide(state, {
      id,
      requestId: id,
      actorId: 'finals-replay-preview',
      at: Date.now(),
      operator: true,
      command: {
        kind: 'matchControl',
        matchId: call.id,
        expectedRevision: call.revision,
        expectedResourceRevision: state.settings.resourceRevision,
        status: 'ready',
        stationId: null,
        reason: null,
      },
    });
    if (
      decision &&
      reviewFinalsSlotReplay(reduceDecision(state, decision), score, reviewVersion).preview.allowed
    )
      return { ...review.preview, returnCallMatchIds: [call.id] };
  } catch (error) {
    if (!(error instanceof TournamentConflict)) throw error;
  }
  return review.preview;
}
