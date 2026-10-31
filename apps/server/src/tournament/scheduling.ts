import { dispatchAvailability, isReserved, sharedDispatch } from './dispatch';
import { available, matchMemberIds } from './entrants';
import { buildStationQueues } from '../event-operations/queue';
import { requireFact, resolved } from './facts';
import { hasCurrentPendingScoreReview } from './scoreReview';
import type { CommandEnvelope, TournamentState } from './schemas';
export function dispatchMatch(
  next: TournamentState,
  envelope: CommandEnvelope,
  command: Extract<CommandEnvelope['command'], { kind: 'dispatch' }>,
  basis: Record<string, number>,
) {
  const match = next.matches.find((m) => m.id === command.matchId);
  requireFact(
    match && match.status === 'ready' && match.player1Id && match.player2Id,
    'Match is not ready.',
  );
  requireFact(
    match.revision === command.expectedRevision &&
      next.settings.resourceRevision === command.expectedResourceRevision,
    'Pairing or resources changed.',
  );
  basis[match.id] = match.revision;
  basis.resources = next.settings.resourceRevision;
  requireFact(
    !hasCurrentPendingScoreReview(match, next.reports),
    'This match has a score awaiting TO review.',
  );
  if (sharedDispatch(next)) {
    requireFact(envelope.operator, 'An organiser calls matches from the shared queue.');
    const availability = dispatchAvailability(next, match);
    const allowed = command.stationId
      ? isReserved(next, command.stationId) &&
        availability.eligibleStationIds.includes(command.stationId)
      : availability.canDispatchOrdinary;
    requireFact(
      allowed,
      availability.reasons.map((r) => r.message).join(' ') ||
        (command.stationId
          ? 'Reserved station is unavailable.'
          : 'Ordinary match capacity is full.'),
    );
    match.status = 'playing';
    // A call reserves capacity without claiming that anyone has actually played.
    // Explicit main-stage starts and optional beginPlay record that separate fact.
    match.started ||=
      command.callOnly === false || Boolean(command.stationId && command.callOnly !== true);
    match.stationId = command.stationId;
    match.calledAt = envelope.at;
    match.callLocation = command.callLocation ?? null;
    next.settings.resourceRevision++;
    return;
  }
  if (!envelope.operator)
    requireFact(
      next.settings.published &&
        (envelope.guest || next.settings.playerReports) &&
        match.stage === 'group' &&
        next.pools.some((p) => p.id === match.poolId && p.selfRun),
      'Self-service is unavailable for this pairing.',
    );
  if (!envelope.operator) {
    requireFact(command.stationId, 'Self-service requires a station.');
    const queues = buildStationQueues(
      next.matches.map((m) => ({
        ...m,
        nativeRound: m.round || null,
        nativeSlot: m.slot,
        poolIndex: next.pools.find((p) => p.id === m.poolId)?.index ?? null,
      })),
      next.stations,
      next.pools.map((p) => ({ ...p, poolIndex: p.index })),
      next.entrants.filter((e) => !available(e)).map((e) => e.playerId),
      true,
      new Set(
        next.matches
          .filter((item) => hasCurrentPendingScoreReview(item, next.reports))
          .map((item) => item.id),
      ),
    );
    requireFact(
      queues.stationQueues.some(
        (q) => q.stationId === command.stationId && q.nextMatchId === match.id,
      ),
      'Only the next queued match can start here.',
    );
  }
  requireFact(
    !match.qualificationBlocks?.length,
    match.blockedReason ?? 'Resolve the relevant pool qualification first.',
  );
  const active = next.matches.filter((m) => m.status === 'playing');
  requireFact(active.length < next.settings.capacity, 'Shared match capacity is full.');
  requireFact(
    !active.some((m) =>
      matchMemberIds(next, m).some((id) => matchMemberIds(next, match).includes(id)),
    ),
    'A player is already playing.',
  );
  requireFact(
    next.entrants
      .filter((e) => e.playerId === match.player1Id || e.playerId === match.player2Id)
      .every(available),
    'A player is unavailable.',
  );
  const pool = next.pools.find((p) => p.id === match.poolId);
  requireFact(!pool || pool.active, 'This pool is paused.');
  if (command.stationId)
    requireFact(
      next.stations.some((s) => s.id === command.stationId && s.enabled) &&
        !active.some((m) => m.stationId === command.stationId),
      'Reserved station is unavailable.',
    );
  if (pool?.stationIds.length)
    requireFact(
      command.stationId && pool.stationIds.includes(command.stationId),
      'Choose a station allocated to this pool.',
    );
  if (command.stationId)
    requireFact(
      !next.pools.some(
        (p) =>
          p.id !== match.poolId &&
          p.active &&
          p.stationIds.includes(command.stationId!) &&
          next.matches.some((m) => m.poolId === p.id && !resolved(m)),
      ),
      'This station is reserved for another unfinished pool.',
    );
  match.status = 'playing';
  match.started = true;
  match.stationId = command.stationId;
  next.settings.resourceRevision++;
}
