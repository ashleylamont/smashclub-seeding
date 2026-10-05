/** Compare WHR club rank with its conservative seeding order. */
import {
  runWhrModel,
  seedingOrder,
  type EngineSet,
  type EngineTournament,
  type EvalSet,
} from '@smashclub/engine';
import { defaultRatingSettings } from '@smashclub/shared';

function toEngineInput(sets: readonly EvalSet[]): {
  sets: EngineSet[];
  tournaments: EngineTournament[];
} {
  const tournaments = new Map<string, EngineTournament>();
  const engineSets: EngineSet[] = [];
  sets.forEach((set, index) => {
    if (!tournaments.has(set.tournamentId)) {
      tournaments.set(set.tournamentId, {
        id: set.tournamentId,
        // Times are days since an origin; any consistent ISO date works.
        eventDate: new Date(Date.UTC(2024, 0, 1) + set.time * 86_400_000).toISOString(),
        isRookie: /rookie/i.test(set.tournamentId),
        challongeId: null,
      });
    }
    engineSets.push({
      id: `s${index}`,
      tournamentId: set.tournamentId,
      p1PlayerId: set.p1PlayerId,
      p2PlayerId: set.p2PlayerId,
      winner: set.winner,
      suggestedPlayOrder: index,
      completedAt: null,
      challongeMatchId: index,
    });
  });
  return { sets: engineSets, tournaments: [...tournaments.values()] };
}

export function impactReport(sets: readonly EvalSet[], anonymise: boolean): void {
  const { leaderboard } = runWhrModel({ ...toEngineInput(sets), settings: defaultRatingSettings });
  const label = (id: string) => {
    if (!anonymise) return id;
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
    return `player-${String(hash).padStart(5, '0')}`;
  };
  const seeds = seedingOrder(leaderboard);
  console.log(`\nWHR: ${leaderboard.length} players; club rating and conservative seeding`);
  for (const row of leaderboard.slice(0, 8)) {
    const seed = seeds.findIndex((s) => s.playerId === row.playerId) + 1;
    console.log(
      `${label(row.playerId)} rank ${row.rank}, seed ${seed}, skill ${row.skillRating.toFixed(0)} ±${row.skillSd.toFixed(0)}, attendance −${row.activityPenalty}`,
    );
  }
}
