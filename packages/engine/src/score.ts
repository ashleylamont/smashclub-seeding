import type { GlickoSettings } from '@smashclub/shared';
import type { PlayerFinalState } from './types';

/**
 * The conservative seeding score and its confidence breakdown, ported from
 * the legacy calculate_player_score. The blend guards against small-sample
 * and rookie-island inflation:
 *
 * - isolation: rookie-heavy players with little main-bracket exposure get
 *   their RD inflated and their distance from 1500 anchored down.
 * - sample confidence: few tournaments/opponents/sets shrink the distance
 *   from 1500.
 * - conservative = effectiveRating - 2 * effectiveRd.
 */
export interface PlayerScore {
  playerId: string;
  rating: number;
  rd: number;
  vol: number;
  effectiveRating: number;
  effectiveRd: number;
  conservativeRating: number;
  matchCount: number;
  wins: number;
  losses: number;
  mainMatchCount: number;
  rookieMatchCount: number;
  tournamentCount: number;
  uniqueOpponentCount: number;
  bridgeOpponentCount: number;
  rookieRatio: number;
  isolationFactor: number;
  sampleConfidence: number;
  lastPlayedDate: string;
}

export interface LeaderboardRow extends PlayerScore {
  rank: number;
  league: string;
}

export function computePlayerScore(
  state: PlayerFinalState,
  finalStates: ReadonlyMap<string, PlayerFinalState>,
  settings: GlickoSettings,
): PlayerScore {
  const rookieRatio = state.matchCount ? state.rookieMatchCount / state.matchCount : 0;
  const mainExperienceFactor = state.matchCount ? Math.min(state.mainMatchCount, 5) / 5 : 0;
  let bridgeOpponentCount = 0;
  for (const opponentId of state.opponentIds) {
    if ((finalStates.get(opponentId)?.mainMatchCount ?? 0) > 0) bridgeOpponentCount += 1;
  }
  const bridgeFactor = state.matchCount ? Math.min(bridgeOpponentCount, 5) / 5 : 0;
  const isolationFactor = rookieRatio * (1 - Math.max(mainExperienceFactor, bridgeFactor));
  const rookieOnlyIsland =
    state.mainMatchCount === 0 && bridgeOpponentCount === 0 && state.rookieMatchCount >= 3;

  const rookieRdMultiplier = 1 + 0.9 * isolationFactor + (rookieOnlyIsland ? 0.5 : 0);
  const effectiveRd = Math.min(settings.rdCap, state.rd * rookieRdMultiplier);

  const anchorFactor = Math.max(0.25, 1 - 0.65 * isolationFactor - (rookieOnlyIsland ? 0.2 : 0));
  const tournamentFactor = Math.min(state.tournamentIds.size, 3) / 3;
  const opponentFactor = Math.min(state.opponentIds.size, 8) / 8;
  const matchFactor = Math.min(state.matchCount, 10) / 10;
  const baseSampleConfidence = Math.max(
    settings.confidenceFloor,
    Math.min(
      1,
      settings.confidenceTournamentWeight * tournamentFactor +
        settings.confidenceOpponentWeight * opponentFactor +
        settings.confidenceMatchWeight * matchFactor,
    ),
  );
  const overlapConfidence = Math.max(mainExperienceFactor, bridgeFactor, settings.anchorFloor);
  const sampleConfidence =
    rookieRatio > 0
      ? Math.max(settings.anchorFloor, Math.min(baseSampleConfidence, overlapConfidence + 0.25 * (1 - rookieRatio)))
      : baseSampleConfidence;

  const effectiveRating =
    settings.initialRating + (state.rating - settings.initialRating) * anchorFactor * sampleConfidence;
  const conservativeRating = effectiveRating - 2 * effectiveRd;

  return {
    playerId: state.playerId,
    rating: state.rating,
    rd: state.rd,
    vol: state.vol,
    effectiveRating,
    effectiveRd,
    conservativeRating,
    matchCount: state.matchCount,
    wins: state.wins,
    losses: state.losses,
    mainMatchCount: state.mainMatchCount,
    rookieMatchCount: state.rookieMatchCount,
    tournamentCount: state.tournamentIds.size,
    uniqueOpponentCount: state.opponentIds.size,
    bridgeOpponentCount,
    rookieRatio,
    isolationFactor,
    sampleConfidence,
    lastPlayedDate: state.lastPlayedDate,
  };
}

/** Quartile-based league labels (legacy emoji names preserved). */
export function leagueForRating(conservativeRating: number, allConservativeRatings: readonly number[]): string {
  if (allConservativeRatings.length === 0) return '👶 Smashclub Interns';
  const sorted = [...allConservativeRatings].sort((a, b) => b - a);
  const n = sorted.length;
  if (conservativeRating >= sorted[Math.floor(n / 4)]!) return '🏆 Champions';
  if (conservativeRating >= sorted[Math.floor(n / 2)]!) return '💼 Smashclub Full-Timers';
  if (conservativeRating >= sorted[Math.floor((3 * n) / 4)]!) return '🎓 Smashclub Grads';
  return '👶 Smashclub Interns';
}

/**
 * Ranked leaderboard, sorted by the legacy seeding key: conservative rating
 * desc, then raw rating desc, then RD asc, then player ID for determinism.
 */
export function computeLeaderboard(
  finalStates: ReadonlyMap<string, PlayerFinalState>,
  settings: GlickoSettings,
): LeaderboardRow[] {
  const scores = [...finalStates.values()].map((state) => computePlayerScore(state, finalStates, settings));
  scores.sort(
    (a, b) =>
      b.conservativeRating - a.conservativeRating ||
      b.rating - a.rating ||
      a.rd - b.rd ||
      (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );
  const allConservative = scores.map((s) => s.conservativeRating);
  return scores.map((score, index) => ({
    ...score,
    rank: index + 1,
    league: leagueForRating(score.conservativeRating, allConservative),
  }));
}
