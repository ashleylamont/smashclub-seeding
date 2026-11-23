import { playerRatings, players, type Db } from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { and, eq } from 'drizzle-orm';
import { latestRecomputeId } from '../recompute/recompute';
import { charactersForPlayer } from './characters';

export function readPublicPlayerPreview(database: Db, playerId: string) {
  return database.transaction(
    async (db) => {
      const [player] = await db
        .select({
          canonicalName: players.canonicalName,
          displayName: players.displayName,
          status: players.status,
          mergedIntoPlayerId: players.mergedIntoPlayerId,
        })
        .from(players)
        .where(eq(players.id, playerId));
      if (!player) return null;
      if (player.status === 'merged' && player.mergedIntoPlayerId) {
        return { profile: null, redirectTo: player.mergedIntoPlayerId };
      }

      const recomputeId = await latestRecomputeId(db);
      const ratings = recomputeId
        ? await db
            .select({
              clubRating: playerRatings.clubRating,
              wins: playerRatings.wins,
              losses: playerRatings.losses,
              isProvisional: playerRatings.isProvisional,
            })
            .from(playerRatings)
            .where(
              and(eq(playerRatings.recomputeId, recomputeId), eq(playerRatings.playerId, playerId)),
            )
        : [];
      return {
        profile: {
          name: publicPlayerName(player),
          characters: await charactersForPlayer(db, playerId),
          rating: ratings.at(0) ?? null,
        },
        redirectTo: null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
