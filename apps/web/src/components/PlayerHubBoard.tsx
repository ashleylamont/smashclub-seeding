import { EventPools, EventBrackets } from './EventNightBoard';
import { MatchCard } from './EventMatchCard';
import { ResultGraphic } from './ResultGraphic';
import { confirmedPoolGraphics } from '../lib/resultGraphic';
import { playerBracketPath, playerHubView } from '../lib/playerHubView';
import { liveBracketSide, liveBracketStatus } from '../lib/eventBracket';
import { Disclosure } from './ui/Disclosure';
import { matchStation } from '../lib/playerMatchView';
import { nextMeaningfulMatch } from '../lib/matchPresentation';
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
  const labels = new Map(data.matches.map((match) => [match.id, match.label]));
  const path = player
    ? playerBracketPath(
        data.matches.filter((match) =>
          board.nativeBrackets.some((bracket) => bracket.id === match.nativeBracketId),
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
    />
  );
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
        className="event-display player-event-board-section"
      >
        <EventPools
          matches={board.pools}
          schedules={data.poolSchedules ?? []}
          stations={data.stations}
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
        className="event-display player-event-board-section"
      >
        {player && board.nativeBrackets.length > 0 ? (
          <>
            <h2>Your bracket path</h2>
            <p className="event-live-note">
              Published pairings and possible later rounds. Later opponents depend on confirmed
              results.
            </p>
            <ol className="player-bracket-path">
              {path.map((match) => (
                <li key={match.id}>
                  <strong>{match.label}</strong> · {liveBracketStatus(match)}
                  <p>
                    {liveBracketSide(match, 0, labels)} vs {liveBracketSide(match, 1, labels)}
                  </p>
                </li>
              ))}
            </ol>
            {board.nativeBrackets.map((bracket) => {
              const place = bracket.standings.find((item) => board.identities.has(item.playerId));
              return place ? (
                <p key={bracket.id}>
                  Confirmed {bracket.stage === 'main' ? 'championship' : 'consolation'} place ·{' '}
                  {place.place}
                </p>
              ) : null;
            })}
            {!path.length && (
              <p>Your bracket is published. Open the full draw for its current standings.</p>
            )}
            <Disclosure title="Full draw & bracket standings">{bracketView}</Disclosure>
          </>
        ) : (
          bracketView
        )}
        {!board.nativeBrackets.length && !board.linked.some((item) => item.slug) && (
          <>
            <h2>Brackets</h2>
            <p>
              {data.plan.structure === 'round_robin'
                ? 'This event uses pool standings to decide the result; there is no finals bracket.'
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
        className="event-display player-event-board-section event-recent"
      >
        <h2>Recorded results</h2>
        <div className="event-results-grid">
          {board.results.map((match) => (
            <MatchCard
              key={match.id}
              match={match}
              nextMatch={nextMeaningfulMatch(data.matches, match)}
              station={matchStation(data, match).name ?? undefined}
            />
          ))}
        </div>
        {!board.results.length && <p>Results appear here once confirmed.</p>}
        <p className="event-live-note">
          Set results are shown as recorded. They do not imply final tournament placements.
        </p>
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
            <h2>On the line</h2>
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
