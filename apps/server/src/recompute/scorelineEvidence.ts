import { parseScoresCsv, whrSetTrials } from '@smashclub/engine';
import { isPlayedRatingResult } from '@smashclub/shared';

export interface PublishedScorelineEvidence {
  weight: number;
  won: boolean | null;
}

export type ScorelineEvidence =
  | { weight: number | null; evidenceUnavailable?: never }
  | { weight: null; evidenceUnavailable: 'history_changed' | 'not_rated' | 'older_run' };

export function verifiedScorelineEvidence(
  result: { eligible: boolean; winner: number | null; scoresCsv: string | null; raw: unknown },
  published: PublishedScorelineEvidence,
  currentWon: boolean | null,
  gamesWeight: number | null,
): ScorelineEvidence {
  const { eligible, winner, scoresCsv, raw } = result;
  if (!eligible || (winner !== 1 && winner !== 2) || !isPlayedRatingResult(scoresCsv, raw))
    return { weight: null, evidenceUnavailable: 'not_rated' };
  if (gamesWeight === null) return { weight: null, evidenceUnavailable: 'older_run' };

  // Evidence units depend on the set's winner and margin under the frozen rule.
  // The broader fit, impact and forecast have their own prefix checks.
  const score = parseScoresCsv(scoresCsv);
  const weight = whrSetTrials(
    { winner, p1Games: score.unknown ? null : score.p1, p2Games: score.unknown ? null : score.p2 },
    gamesWeight,
  );
  return currentWon !== null && currentWon === published.won && weight === published.weight
    ? { weight }
    : { weight: null, evidenceUnavailable: 'history_changed' };
}
