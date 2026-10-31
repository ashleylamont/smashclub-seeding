import { broadcastOrientation, type BroadcastSidePreferences } from '@smashclub/shared';
import type { LiveMatch } from './eventDisplay';

type DisplayMatch = LiveMatch & { revision?: number };
export function broadcastPlayers(
  data: { matches: readonly LiveMatch[]; broadcastSides?: BroadcastSidePreferences },
  match: DisplayMatch | undefined,
) {
  if (!match) return undefined;
  const orientation = broadcastOrientation(
    { ...match, revision: match.revision ?? 0 },
    data.broadcastSides,
  );
  const players = [
    {
      id: match.player1Id,
      name: match.player1Name,
      score: match.score1,
      characters: match.player1Characters ?? [],
    },
    {
      id: match.player2Id,
      name: match.player2Name,
      score: match.score2,
      characters: match.player2Characters ?? [],
    },
  ];
  return {
    ...orientation,
    left: players[orientation.swapped ? 1 : 0]!,
    right: players[orientation.swapped ? 0 : 1]!,
  };
}
