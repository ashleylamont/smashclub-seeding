import type { Match, TournamentState } from './schemas';

/** Older reports remain audit evidence, not holds on a changed pairing/result. */
export function hasCurrentPendingScoreReview(
  match: Pick<Match, 'id' | 'revision'>,
  reports: readonly Pick<
    TournamentState['reports'][number],
    'matchId' | 'expectedRevision' | 'status'
  >[],
) {
  return reports.some(
    (report) =>
      report.status === 'pending' &&
      report.matchId === match.id &&
      report.expectedRevision === match.revision,
  );
}
