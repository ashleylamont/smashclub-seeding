import { buildStationQueues } from '../event-operations/queue';
import { requireFact, resolved } from './facts';
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
        poolIndex: next.pools.find((p) => p.id === m.poolId)?.index ?? null,
      })),
      next.stations,
      next.pools.map((p) => ({ ...p, poolIndex: p.index })),
      next.entrants.filter((e) => e.availability !== 'available').map((e) => e.playerId),
    );
    requireFact(
      queues.stationQueues.some(
        (q) => q.stationId === command.stationId && q.nextMatchId === match.id,
      ),
      'Only the next queued match can start here.',
    );
  }
  const active = next.matches.filter((m) => m.status === 'playing');
  requireFact(active.length < next.settings.capacity, 'Shared match capacity is full.');
  requireFact(
    !active.some((m) =>
      [m.player1Id, m.player2Id].some((id) => id === match.player1Id || id === match.player2Id),
    ),
    'A player is already playing.',
  );
  requireFact(
    next.entrants
      .filter((e) => e.playerId === match.player1Id || e.playerId === match.player2Id)
      .every((e) => e.availability === 'available'),
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
