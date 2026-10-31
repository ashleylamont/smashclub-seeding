import { recentResults, resultHeadline, type ResultMatch } from '../lib/broadcastResults';
import { resultStageLabel } from '../lib/broadcastSidebar';
import { matchParticipantName, matchPresentation } from '../lib/matchPresentation';

/** Stable match IDs update a corrected result in place; only the footer owns result flashes. */
export function BroadcastRecentSets({
  matches,
  count,
}: {
  matches: readonly ResultMatch[];
  count: number;
}) {
  const results = recentResults(matches, count);
  return (
    <section className="broadcast-deck broadcast-recent-sets" aria-label="Recent resolved sets">
      <div className="broadcast-rail-rule">
        <span>RECENT RESULTS</span>
        <span>↘</span>
      </div>
      {results.length ? (
        results.map((match) => {
          const presentation = matchPresentation(match);
          return (
            <article
              key={match.id}
              data-match-id={match.id}
              data-outcome={presentation.kind}
              aria-label={`${resultStageLabel(match)} · ${resultHeadline(match)}`}
            >
              <small>{resultStageLabel(match)}</small>
              {([0, 1] as const)
                .filter(
                  (side) =>
                    presentation.kind !== 'bye' ||
                    (side === 0 ? match.player1Id : match.player2Id) === match.winnerId,
                )
                .map((side) => {
                  const id = side === 0 ? match.player1Id : match.player2Id;
                  return (
                    <div className={id === match.winnerId ? 'is-winner' : ''} key={side}>
                      <strong title={matchParticipantName(match, side)}>
                        {matchParticipantName(match, side)}
                      </strong>
                      {presentation.showScores && (
                        <b>{(side === 0 ? match.score1 : match.score2) ?? '–'}</b>
                      )}
                    </div>
                  );
                })}
              {!presentation.showScores && (
                <span className="broadcast-set-outcome">
                  {presentation.kind === 'bye'
                    ? 'Advanced automatically · Bye'
                    : presentation.result}
                </span>
              )}
            </article>
          );
        })
      ) : (
        <p className="broadcast-wait">No confirmed results yet.</p>
      )}
    </section>
  );
}
