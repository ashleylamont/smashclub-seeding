/** Display order is scoped to a station's exact active pairing, never a tournament result. */
export interface BroadcastSidePreference {
  matchId: string;
  player1Id: string;
  player2Id: string;
  matchRevision: number;
  swapped: boolean;
  revision: number;
}
export type BroadcastSidePreferences = Record<string, BroadcastSidePreference>;
export interface BroadcastPairing {
  id: string;
  status: string;
  stationId: string | null;
  player1Id: string | null;
  player2Id: string | null;
  revision: number;
}
export function broadcastOrientation(
  match: BroadcastPairing,
  preferences?: BroadcastSidePreferences,
) {
  const saved = preferences?.[match.stationId ?? ''];
  return {
    revision: saved?.revision ?? 0,
    swapped: Boolean(
      match.status === 'playing' &&
      saved?.swapped &&
      saved.matchId === match.id &&
      saved.player1Id === match.player1Id &&
      saved.player2Id === match.player2Id &&
      saved.matchRevision === match.revision,
    ),
  };
}
