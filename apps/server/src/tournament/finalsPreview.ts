import { randomUUID } from 'node:crypto';
import { appendQualifierBracket } from './rollingFinals';
import { planStrengthFinals, strengthFinalsToken, strengthSeedPolicy } from './strengthFinals';
import { drawFinals } from './brackets';
import { finalsToken, resetFinals } from './operations';
import { poolOrderStatus } from './poolOrders';
import { completeCommandProgression } from './progression';
import type { CommandEnvelope, TournamentState } from './schemas';

export const rollingFieldWarning =
  'Creating finals fixes the current eligible field, pool-place sources and seeds. Later withdrawals resolve by availability/forfeit; restoring an excluded entrant does not add a finals place. The draw will not shrink or reseed while other pools finish.';

function finalsResetIssues(state: TournamentState) {
  if (!state.brackets.length) return ['No finals exist.'];
  try {
    resetFinals(structuredClone(state));
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : 'Cannot remove these finals.'];
  }
}

export function previewRollingFinals(state: TournamentState) {
  const trial = structuredClone(state);
  const existing = Boolean(state.brackets.length);
  const issues: string[] = [];
  if (state.lifecycle !== 'locked') issues.push('The event is not open.');
  if (!existing) {
    try {
      const envelope: CommandEnvelope = {
        id: randomUUID(),
        requestId: 'preview',
        actorId: 'preview',
        operator: true,
        at: Date.now(),
        command: { kind: 'drawFinals' },
      };
      drawFinals(trial, envelope);
      completeCommandProgression(state, trial, envelope, {});
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Cannot reserve finals.');
    }
  }
  const resetIssues = finalsResetIssues(state);
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
    poolOrders: trial.pools.map((p) => ({
      poolId: p.id,
      division: p.division,
      poolIndex: p.index,
      ...poolOrderStatus(trial, p),
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

export function previewStrengthFinals(state: TournamentState) {
  const plan = planStrengthFinals(state);
  const trial = structuredClone(state);
  const envelope: CommandEnvelope = {
    id: randomUUID(),
    requestId: 'preview',
    actorId: 'preview',
    operator: true,
    at: Date.now(),
    command: { kind: 'drawFinals', seedPolicy: strengthSeedPolicy },
  };
  for (const { division, stage, ready } of plan.stages) {
    if (!ready) continue;
    appendQualifierBracket(trial, envelope, division, stage, ready.slots, ready.seeding);
  }
  const existing = Boolean(state.brackets.length);
  const resetIssues = finalsResetIssues(state);
  const issues: string[] = [];
  if (state.lifecycle !== 'locked') issues.push('The event is not open.');
  const newBrackets = trial.brackets.length - state.brackets.length;
  const poolOrders = state.pools.map((pool) => ({
    poolId: pool.id,
    division: pool.division,
    poolIndex: pool.index,
    ...poolOrderStatus(state, pool),
  }));
  return {
    seedPolicy: strengthSeedPolicy,
    existing,
    allowed: Boolean(newBrackets) && !issues.length,
    issues,
    replacing: false,
    resetAllowed: !resetIssues.length,
    resetIssues,
    resetRevisionToken: finalsToken(state),
    revisionToken: strengthFinalsToken(state, plan),
    poolOrders,
    waitingStages: plan.stages
      .filter((stage) => stage.waiting.length)
      .map(({ division, stage, waiting }) => ({ division, stage, waiting })),
    brackets: trial.brackets.map((b) => ({
      ...b,
      alreadyDrawn: state.brackets.some((bracket) => bracket.id === b.id),
      roundOne: trial.matches
        .filter((m) => m.bracketId === b.id && m.round === 1)
        .map((m) => ({
          player1Id: m.player1Id,
          player2Id: m.player2Id,
          player1Qualifier: m.player1Qualifier,
          player2Qualifier: m.player2Qualifier,
        })),
    })),
  };
}
