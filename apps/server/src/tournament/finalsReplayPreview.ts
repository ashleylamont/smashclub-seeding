import { randomUUID } from 'node:crypto';
import { decide, reduceDecision, TournamentConflict } from './domain';
import { reviewFinalsSlotReplay, type ReplayScore } from './finalsSlotReplay';
import { reviewPlayoffPoolScore } from './poolGameCorrection';
import type { TournamentState } from './schemas';

export function previewFinalsSlotReplay(
  state: TournamentState,
  score: ReplayScore,
  reviewVersion: 1 | 2 | 3 = 1,
) {
  const replayVersion = reviewVersion === 1 ? 1 : 2;
  const review = reviewFinalsSlotReplay(state, score, replayVersion);
  if (
    reviewVersion === 3 &&
    !review.preview.allowed &&
    !review.preview.qualifierChanges.length &&
    (state.baseline?.structure === 'round_robin_finals' || 'unchangedQualifierSlots' in review)
  ) {
    try {
      const { order, pool, revisionToken } = reviewPlayoffPoolScore(state, score);
      const changes = order.flatMap((entrantId, index) => {
        const beforePlace = pool.order!.indexOf(entrantId) + 1;
        const afterPlace = index + 1;
        return beforePlace === afterPlace ? [] : [{ entrantId, beforePlace, afterPlace }];
      });
      return {
        allowed: true as const,
        issues: [],
        qualifierChanges: [],
        poolPlacementCorrection: true as const,
        changes,
        revisionToken,
      };
    } catch (error) {
      if (!(error instanceof TournamentConflict)) throw error;
      return { ...review.preview, issues: [error.message] };
    }
  }
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
      reviewFinalsSlotReplay(reduceDecision(state, decision), score, replayVersion).preview.allowed
    )
      return { ...review.preview, returnCallMatchIds: [call.id] };
  } catch (error) {
    if (!(error instanceof TournamentConflict)) throw error;
  }
  return review.preview;
}
