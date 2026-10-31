import { randomUUID } from 'node:crypto';
import { drawFinals } from './brackets';
import { finalsToken, resetFinals } from './operations';
import { poolOrderStatus } from './poolOrders';
import type { TournamentState } from './schemas';

export const rollingFieldWarning =
  'Creating finals fixes the current eligible field, pool-place sources and seeds. Later withdrawals resolve by availability/forfeit; restoring an excluded entrant does not add a finals place. The draw will not shrink or reseed while other pools finish.';

export function previewRollingFinals(state: TournamentState) {
  const trial = structuredClone(state);
  const existing = Boolean(state.brackets.length);
  const issues: string[] = [];
  if (state.lifecycle !== 'locked') issues.push('The event is not open.');
  if (!existing) {
    try {
      drawFinals(trial, {
        id: randomUUID(),
        requestId: 'preview',
        actorId: 'preview',
        operator: true,
        at: Date.now(),
        command: { kind: 'drawFinals' },
      });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Cannot reserve finals.');
    }
  }
  const resetIssues: string[] = [];
  if (!existing) resetIssues.push('No finals exist.');
  else {
    try {
      resetFinals(structuredClone(state));
    } catch (error) {
      resetIssues.push(error instanceof Error ? error.message : 'Cannot remove these finals.');
    }
  }
  return {
    rolling: true as const,
    existing,
    freezeWarning: rollingFieldWarning,
    allowed: !existing && !issues.length,
    issues,
    replacing: false,
    resetAllowed: !resetIssues.length,
    resetIssues,
    revisionToken: finalsToken(state),
    poolOrders: state.pools.map((p) => ({
      poolId: p.id,
      division: p.division,
      poolIndex: p.index,
      ...poolOrderStatus(state, p),
    })),
    brackets: trial.brackets.map((b) => ({
      ...b,
      roundOne: trial.matches
        .filter((m) => m.bracketId === b.id && m.round === 1)
        .map((m) => ({
          player1Id: m.player1Id,
          player2Id: m.player2Id,
          player1Qualifier: m.player1Qualifier,
          player2Qualifier: m.player2Qualifier,
          qualificationBlocks: m.qualificationBlocks,
          status: m.status,
          outcome: m.outcome,
        })),
    })),
  };
}
