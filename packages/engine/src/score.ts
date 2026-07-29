import { LEAGUE_CATCH_ALL, type GlickoSettings } from '@smashclub/shared';
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
  /**
   * Best estimate of skill, and what the public leaderboard ranks on. This is
   * the shrunk point estimate (a posterior mean): pulled toward 1500 in
   * proportion to how little we know, but *not* additionally penalised by
   * uncertainty. Display it alongside `skillSd` so doubt is visible rather
   * than baked destructively into the number.
   */
  skillRating: number;
  /** One standard deviation of uncertainty on `skillRating`, for a ± band. */
  skillSd: number;
  /**
   * Deliberately pessimistic estimate, and what bracket seeding uses, where
   * being cautious about an unknown player is the correct behaviour.
   *
   * Ranking and seeding were previously the same number, which stacked
   * confidence shrinkage on top of a −2·RD penalty. On the club's real data
   * that made 94% of the median player's distance below 1500 pure uncertainty
   * (a displayed 922 against a skill estimate of 1475) and left the published
   * order correlating −0.86 with RD and +0.81 with match count — i.e. it
   * measured attendance nearly as much as skill.
   */
  conservativeRating: number;
  matchCount: number;
  wins: number;
  losses: number;
  mainMatchCount: number;
  rookieMatchCount: number;
  /** Brackets entered. */
  tournamentCount: number;
  /**
   * Events (occasions) attended — what a member means by "how many have I been
   * to". Lower than `tournamentCount` for anyone who played both the main and
   * the rookie bracket on one evening.
   */
  eventCount: number;
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
    skillRating: effectiveRating,
    skillSd: effectiveRd,
    conservativeRating,
    matchCount: state.matchCount,
    wins: state.wins,
    losses: state.losses,
    mainMatchCount: state.mainMatchCount,
    rookieMatchCount: state.rookieMatchCount,
    tournamentCount: state.tournamentIds.size,
    eventCount: state.eventKeys.size,
    uniqueOpponentCount: state.opponentIds.size,
    bridgeOpponentCount,
    rookieRatio,
    isolationFactor,
    sampleConfidence,
    lastPlayedDate: state.lastPlayedDate,
  };
}

/**
 * League from fixed rating bands.
 *
 * Previously these were live quartiles of whoever was in the field, so a
 * player's league could change because *other* people played, and a label
 * carried no meaning across time. With absolute thresholds, promotion and
 * relegation are real events. Calibrate the bands once from the field
 * (`calibrateLeagueBands`), store them, then leave them alone.
 */
export function leagueForRating(
  skillRating: number,
  bands: ReadonlyArray<{ name: string; minRating: number }>,
): string {
  const ordered = [...bands].sort((a, b) => b.minRating - a.minRating);
  for (const band of ordered) {
    if (skillRating >= band.minRating) return band.name;
  }
  return ordered[ordered.length - 1]?.name ?? 'Unranked';
}

/**
 * Derives absolute band thresholds from the current field's quartiles, so the
 * one-off switch from quartiles to fixed bands preserves today's distribution
 * as its starting point.
 */
export function calibrateLeagueBands(
  skillRatings: readonly number[],
  names: readonly string[] = ['🏆 Champions', '💼 Smashclub Full-Timers', '🎓 Smashclub Grads', '👶 Smashclub Interns'],
): Array<{ name: string; minRating: number }> {
  if (skillRatings.length === 0) {
    return names.map((name, index) => ({
      name,
      minRating: index === names.length - 1 ? LEAGUE_CATCH_ALL : 1500 + (names.length - 1 - index) * 100,
    }));
  }
  const sorted = [...skillRatings].sort((a, b) => b - a);
  return names.map((name, index) => {
    if (index === names.length - 1) return { name, minRating: LEAGUE_CATCH_ALL };
    const cut = Math.floor((sorted.length * (index + 1)) / names.length);
    return { name, minRating: Math.round(sorted[Math.min(cut, sorted.length - 1)]!) };
  });
}

/**
 * Public leaderboard, ranked on best-estimate skill.
 *
 * Ties break on lower uncertainty then player id, so the order is stable. Use
 * `seedingOrder` for brackets — that is a different question and wants the
 * conservative estimate.
 */
export function computeLeaderboard(
  finalStates: ReadonlyMap<string, PlayerFinalState>,
  settings: GlickoSettings,
): LeaderboardRow[] {
  const scores = [...finalStates.values()].map((state) => computePlayerScore(state, finalStates, settings));
  scores.sort(
    (a, b) =>
      b.skillRating - a.skillRating ||
      a.skillSd - b.skillSd ||
      (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );
  return scores.map((score, index) => ({
    ...score,
    rank: index + 1,
    league: leagueForRating(score.skillRating, settings.leagueBands),
  }));
}

/**
 * Seeding order: most conservative estimate first, so an unproven player is not
 * handed a top seed on thin evidence.
 */
export function seedingOrder(scores: readonly PlayerScore[]): PlayerScore[] {
  return [...scores].sort(
    (a, b) =>
      b.conservativeRating - a.conservativeRating ||
      b.skillRating - a.skillRating ||
      a.skillSd - b.skillSd ||
      (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );
}
