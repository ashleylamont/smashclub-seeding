import { parseScoresCsv } from '@smashclub/engine';
import { unplayedResultOutcome } from '@smashclub/shared';

export function playerSetScore(scoresCsv: string | null, raw: unknown, side: 1 | 2) {
  if (unplayedResultOutcome(scoresCsv, raw)) return null;
  const score = parseScoresCsv(scoresCsv);
  if (score.unknown) return null;
  return side === 1 ? `${score.p1}–${score.p2}` : `${score.p2}–${score.p1}`;
}
