import { requireFact } from './facts';
import type { TournamentCommand, TournamentState } from './schemas';

export function changeBroadcastSides(
  state: TournamentState,
  command: Extract<TournamentCommand, { kind: 'broadcastSides' }>,
  basis: Record<string, number>,
) {
  const match = state.matches.find((item) => item.id === command.matchId);
  requireFact(
    match &&
      match.status === 'playing' &&
      match.stationId === command.stationId &&
      match.player1Id === command.player1Id &&
      match.player2Id === command.player2Id &&
      match.revision === command.expectedMatchRevision &&
      state.stations.some((station) => station.id === command.stationId && station.enabled),
    'The broadcast pairing changed. Refresh the main-stage panel before swapping sides.',
  );
  const revision = state.broadcastSides?.[command.stationId]?.revision ?? 0;
  requireFact(
    revision === command.expectedRevision,
    'Broadcast sides changed. Refresh the main-stage panel before swapping sides.',
  );
  basis[match.id] = match.revision;
  basis[`broadcast:${command.stationId}`] = revision;
  state.broadcastSides = {
    ...state.broadcastSides,
    [command.stationId]: {
      matchId: match.id,
      player1Id: command.player1Id,
      player2Id: command.player2Id,
      matchRevision: match.revision,
      swapped: command.swapped,
      revision: revision + 1,
    },
  };
}
