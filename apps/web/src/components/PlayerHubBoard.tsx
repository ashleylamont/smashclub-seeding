import { EventPools, EventBrackets } from './EventNightBoard';
import { MatchCard } from './EventMatchCard';
import { ResultGraphic } from './ResultGraphic';
import { confirmedPoolGraphics } from '../lib/resultGraphic';
import { matchesPool } from '../lib/poolFlow';
import { includesPlayer, matchStation } from '../lib/playerMatchView';
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
  const linked = data.plan.bracketMode === 'native' ? [] : data.brackets;
  const poolResults = confirmedPoolGraphics(
    data.placements.filter(
      (place) => !selectedPool || `${place.division}:${place.poolIndex}` === selectedPool,
    ),
    data.entrants,
  );
  return (
    <>
      <section
        id="event-pools"
        aria-label="Pools"
        className="event-display player-event-board-section"
      >
        <EventPools
          matches={data.matches.filter((match) => matchesPool(match, selectedPool))}
          schedules={data.poolSchedules ?? []}
          stations={data.stations}
        />
        {!data.matches.some((match) => match.stage === 'group') && (
          <>
            <h2>Pools</h2>
            <p>Pools have not been published yet.</p>
          </>
        )}
      </section>
      <section
        id="event-brackets"
        aria-label="Brackets"
        className="event-display player-event-board-section"
      >
        <EventBrackets
          brackets={data.nativeBrackets ?? []}
          matches={data.matches}
          entrants={data.entrants}
          linked={linked}
        />
        {!data.nativeBrackets?.length && !linked.some((item) => item.slug) && (
          <>
            <h2>Brackets</h2>
            <p>
              Brackets will appear here when the organisers publish the draw. Pool results do not
              imply a bracket seed.
            </p>
          </>
        )}
      </section>
      <section
        id="event-results"
        aria-label="Results"
        className="event-display player-event-board-section event-recent"
      >
        <h2>Recorded results</h2>
        <div className="event-results-grid">
          {data.matches
            .filter(
              (match) =>
                match.status === 'complete' &&
                matchesPool(match, selectedPool) &&
                (!player || includesPlayer(match, player)),
            )
            .map((match) => (
              <MatchCard
                key={match.id}
                match={match}
                station={matchStation(data, match).name ?? undefined}
              />
            ))}
        </div>
        {!data.matches.some(
          (match) =>
            match.status === 'complete' &&
            matchesPool(match, selectedPool) &&
            (!player || includesPlayer(match, player)),
        ) && <p>Results appear here once confirmed.</p>}
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
        {data.prizes.length > 0 && (
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
    </>
  );
}
