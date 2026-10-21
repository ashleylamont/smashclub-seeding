import { requireFact } from './facts';
import type { CommandEnvelope, TournamentCommand, TournamentState } from './schemas';

export function retireEvent(
  next: TournamentState,
  envelope: CommandEnvelope,
  command: Extract<TournamentCommand, { kind: 'retire' }>,
) {
  requireFact(!next.retirement, 'This event has already been retired.');
  requireFact(
    next.sequence === command.expectedSequence,
    'The event changed. Review the recovery preview again.',
  );
  requireFact(
    (command.operation === 'reset') === Boolean(command.replacementPlanId) &&
      command.replacementPlanId !== next.baseline!.planId,
    'A reset needs a fresh draft identity.',
  );
  next.lifecycle = 'cancelled';
  next.settings.published = false;
  next.settings.playerReports = false;
  next.retirement = {
    operation: command.operation,
    replacementPlanId: command.replacementPlanId,
    withdrawResults: command.withdrawResults,
    reason: command.reason,
    requestId: envelope.requestId,
    actorId: envelope.actorId,
    at: envelope.at,
  };
}
