import '../styles/event-board.css';
import { EventPools, EventBrackets } from './EventNightBoard';
import { PendingFinals } from './PendingFinals';
import { MatchCard } from './EventMatchCard';
import { ResultGraphic } from './ResultGraphic';
import { confirmedPoolGraphics } from '../lib/resultGraphic';
import { playerBracketPath, playerHubView } from '../lib/playerHubView';
import { liveBracketSide, liveBracketStatus } from '../lib/eventBracket';
import { Disclosure } from './ui/Disclosure';
import { matchStation } from '../lib/playerMatchView';
import { matchPresentation, nextMeaningfulMatch } from '../lib/matchPresentation';
import type { PublicEventSnapshot } from '../lib/usePlayerEventHub';

export function PlayerHubBoard({
  data,
  selectedPool,
  player,
}: {
  data: PublicEventSnapshot;
  selectedPool: string;
  player: string;
}) {
  const board = playerHubView(data, player, selectedPool);
  const superseded = (data.supersededPlayedSets ?? []).filter((set) =>
    player
      ? [set.player1Id, set.player2Id].some((id) => id && board.identities.has(id))
      : !selectedPool,
  );
  const labels = new Map(data.matches.map((match) => [match.id, match.label]));
  const path = player
    ? playerBracketPath(
        data.matches.filter((match) =>
          board.assignedBrackets.some((bracket) => bracket.id === match.nativeBracketId),
        ),
        player,
      )
    : [];
  const bracketView = (
    <EventBrackets
      brackets={board.nativeBrackets}
      matches={data.matches}
      entrants={data.entrants}
      linked={board.linked}
      recordedOnly={board.closed}
    />
  );
  const pendingFinals = (board.closed ? [] : (data.pendingFinals ?? [])).flatMap((field) => {
    if (!player) return [field];
    if (board.assignedBrackets.length) return [];
    const slots = field.slots.filter((slot) =>
      slot.entrantId
        ? board.identities.has(slot.entrantId)
        : board.ownPools.has(`${slot.division}:${slot.poolIndex}`),
    );
    return slots.length ? [{ ...field, slots }] : [];
  });
  const poolResults = confirmedPoolGraphics(
    data.placements.filter(
      (place) =>
        (!selectedPool || `${place.division}:${place.poolIndex}` === selectedPool) &&
        (!player || board.ownPools.has(`${place.division}:${place.poolIndex}`)),
    ),
    data.entrants,
  );
  const sections = {
    pools: (
      <section
        id="event-pools"
        aria-label="Pools"
        className="app-event-board player-event-board-section"
      >
        <EventPools
          matches={board.pools}
          schedules={data.poolSchedules ?? []}
          stations={data.stations}
          recordedOnly={board.closed}
          structure={data.plan.structure}
        />
        {!board.pools.length && (
          <>
            <h2>Pools</h2>
            <p>
              {player
                ? 'No pool is published for this player in this view.'
                : 'No pools are published for this draw.'}
            </p>
          </>
        )}
      </section>
    ),
    brackets: (
      <section
        id="event-brackets"
        aria-label="Brackets"
        className="app-event-board player-event-board-section"
      >
        {player && board.nativeBrackets.length > 0 ? (
          <>
            <h2>
              {!board.closed && board.pendingBrackets.length
                ? 'Finals qualification'
                : 'Your bracket path'}
            </h2>
            {!board.closed && board.pendingBrackets.length ? (
              <p className="event-live-note">
                Your pool order will determine your bracket. These draws show reserved pool places;
                your finals opponents are not confirmed yet.
              </p>
            ) : (
              <p className="event-live-note">
                {board.closed
                  ? 'Your recorded bracket matches and results.'
                  : 'Published pairings and possible later rounds. Later opponents depend on confirmed results.'}
              </p>
            )}
            {path.length > 0 && (
              <ol className="player-bracket-path">
                {path.map((match) => (
                  <li key={match.id}>
                    <strong>{match.label}</strong> · {liveBracketStatus(match, board.closed)}
                    <p>
                      {board.closed && match.status === 'complete' && match.outcome === 'bye'
                        ? matchPresentation(match, true).result
                        : `${liveBracketSide(match, 0, labels)} vs ${liveBracketSide(match, 1, labels)}`}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {board.nativeBrackets.map((bracket) => {
              const place = bracket.standings.find((item) => board.identities.has(item.playerId));
              return place ? (
                <p key={bracket.id}>
                  Confirmed {bracket.stage === 'main' ? 'championship' : 'consolation'} place ·{' '}
                  {place.place}
                </p>
              ) : null;
            })}
            {!board.closed && !path.length && !board.pendingBrackets.length && (
              <p>Your bracket is published. Open the full draw for its current standings.</p>
            )}
            <Disclosure title="Full draw & bracket standings">{bracketView}</Disclosure>
          </>
        ) : (
          bracketView
        )}
        {pendingFinals.length > 0 && (
          <PendingFinals fields={pendingFinals} entrants={data.entrants} />
        )}
        {!pendingFinals.length &&
          !board.nativeBrackets.length &&
          !board.linked.some((item) => item.slug) && (
            <>
              <h2>Brackets</h2>
              <p>
                {data.plan.structure === 'round_robin'
                  ? 'This event uses pool standings to decide the result; there is no finals bracket.'
                  : board.closed
                    ? `No bracket is recorded for this ${player ? 'player' : 'event'}.`
                    : player
                      ? 'Brackets will appear here for this player when the organisers publish the draw. Pool results do not imply a bracket seed.'
                      : 'Brackets will appear here when the organisers publish the draw. Pool results do not imply a bracket seed.'}
              </p>
            </>
          )}
      </section>
    ),
    results: (
      <section
        id="event-results"
        aria-label="Results"
        className="app-event-board player-event-board-section event-recent"
      >
        <h2>Recorded results</h2>
        <div className="event-results-grid">
          {board.results.map((match) => (
            <MatchCard
              key={match.id}
              match={match}
              structure={data.plan.structure}
              nextMatch={board.closed ? undefined : nextMeaningfulMatch(data.matches, match)}
              station={matchStation(data, match, board.closed).name ?? undefined}
            />
          ))}
        </div>
        {!board.results.length && !superseded.length && (
          <p>
            {board.closed
              ? 'No recorded sets in this view.'
              : 'Results appear here once confirmed.'}
          </p>
        )}
        <p className="event-live-note">
          Set results are shown as recorded. They do not imply final tournament placements.
        </p>
        {superseded.length > 0 && (
          <section
            className="player-event-archived-sets"
            aria-label="Played before a finals replay"
          >
            <h3>Played before a finals replay</h3>
            <p>The replay determines who advances.</p>
            <ul>
              {superseded.map((set) => (
                <li key={set.matchId}>
                  <strong>{set.label}</strong>
                  <span>
                    {set.player1Name}{' '}
                    <span className="mono">
                      {set.score1}–{set.score2}
                    </span>{' '}
                    {set.player2Name}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {poolResults.length > 0 && (
          <section className="event-pool-results">
            <h2>Confirmed pool standings</h2>
            <div className="event-results-grid">
              {poolResults.map((pool) => (
                <article className="event-prize" key={pool.title}>
                  <h3>{pool.title}</h3>
                  <ol className="event-pool-ranking">
                    {pool.results.map((result) => (
                      <li key={result.alias}>
                        <span>{result.place}</span> {result.alias}
                      </li>
                    ))}
                  </ol>
                  <ResultGraphic
                    title={`${data.plan.name} · ${pool.title}`}
                    results={pool.results}
                  />
                </article>
              ))}
            </div>
          </section>
        )}
        {(data.plan.resultsSlug || data.plan.historicalResultsSlug) && (
          <p>
            <a
              className="btn"
              href={`/events/${encodeURIComponent(data.plan.resultsSlug ?? data.plan.historicalResultsSlug!)}`}
            >
              {data.plan.historicalResultsSlug
                ? 'View historical results →'
                : 'Final standings and club results →'}
            </a>
          </p>
        )}
        {!player && data.prizes.length > 0 && (
          <>
            <h2>{board.closed ? 'Prizes' : 'On the line'}</h2>
            <div className="event-results-grid">
              {data.prizes.map((prize) => (
                <article className="event-prize" key={prize.id}>
                  <h3>{prize.title}</h3>
                  <p>{prize.description}</p>
                  {prize.playerName && <strong>{prize.playerName}</strong>}
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    ),
  };
  return (
    <>
      {!board.closed &&
        board.activePools &&
        (board.activeBrackets || (player && board.resolvedPools)) && (
          <p className="card player-event-stage-note">
            {player && board.resolvedPools
              ? 'Your pool sets are recorded. '
              : 'Brackets and pools are both in progress. '}
            Other pool sets are still in progress; follow published pairings for your next stage.
          </p>
        )}
      {board.sections.map((section) => (
        <div className="player-event-board-group" key={section}>
          {sections[section]}
        </div>
      ))}
    </>
  );
}
