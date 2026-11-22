import '../styles/event-board.css';
import { EventPools, EventBrackets } from './EventNightBoard';
import { PendingFinals } from './PendingFinals';
import { MatchCard } from './EventMatchCard';
import { ResultGraphic } from './ResultGraphic';
import { confirmedPoolGraphics } from '../lib/resultGraphic';
import { playerBracketPath, playerHubView, type HubBoardSection } from '../lib/playerHubView';
import { liveBracketSide, liveBracketStatus } from '../lib/eventBracket';
import { formatDate } from '../lib/format';
import { Disclosure } from './ui/Disclosure';
import { Button } from './ui/Button';
import { matchStation } from '../lib/playerMatchView';
import { matchPresentation, nextMeaningfulMatch } from '../lib/matchPresentation';
import type { PlayerJourney } from '../lib/playerJourney';
import type { PublicEventSnapshot } from '../lib/usePlayerEventHub';

const endedJourneys = new Set<PlayerJourney['state']>([
  'withdrawn',
  'bracket_finished',
  'winner',
  'pool_finished',
]);

export function PlayerHubBoard({
  data,
  selectedPool,
  player,
  journeyState,
  archiveOnly = false,
}: {
  data: PublicEventSnapshot;
  selectedPool: string;
  player: string;
  journeyState?: PlayerJourney['state'];
  archiveOnly?: boolean;
}) {
  const board = playerHubView(data, player, selectedPool);
  const runEnded = journeyState !== undefined && endedJourneys.has(journeyState);
  const superseded = (data.supersededPlayedSets ?? []).filter((set) =>
    player
      ? [set.player1Id, set.player2Id].some((id) => id && board.identities.has(id))
      : !selectedPool,
  );
  const poolResults = confirmedPoolGraphics(
    data.placements.filter(
      (place) =>
        (!selectedPool || `${place.division}:${place.poolIndex}` === selectedPool) &&
        (!player || board.ownPools.has(`${place.division}:${place.poolIndex}`)),
    ),
    data.entrants,
    data.plan.structure,
  );
  const resultsSlug = data.plan.resultsSlug ?? data.plan.historicalResultsSlug;
  const hasSets = board.results.length > 0 || superseded.length > 0;
  const hasResults = hasSets || poolResults.length > 0 || Boolean(resultsSlug);
  const prizes = player ? [] : data.prizes;
  const archiveSections: HubBoardSection[] = hasResults ? ['results'] : [];
  if (board.hasBrackets) archiveSections.push('brackets');
  if (archiveOnly && !hasResults && prizes.length > 0) archiveSections.push('results');
  const archiveEntry = board.closed ? archiveSections[0] : undefined;
  const sectionOrder = archiveOnly ? archiveSections : board.sections;
  if (archiveOnly && !sectionOrder.length)
    return (
      <section className="card" aria-label="Event archive" data-archive-entry tabIndex={-1}>
        <h2>Event archive</h2>
        <p>No results or brackets are available for this event.</p>
      </section>
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
      <PlayerHubBracketSection
        data={data}
        board={board}
        player={player}
        runEnded={runEnded}
        archiveOnly={archiveOnly}
        archiveEntry={archiveEntry === 'brackets'}
      />
    ),
    results: (
      <section
        id="event-results"
        aria-label={archiveOnly && !hasResults ? 'Prizes' : 'Results'}
        data-archive-entry={archiveEntry === 'results' || undefined}
        tabIndex={archiveEntry === 'results' ? -1 : undefined}
        className="app-event-board player-event-board-section event-recent"
      >
        <h2>{archiveOnly && !hasResults ? 'Prizes' : 'Recorded results'}</h2>
        {(!archiveOnly || board.results.length > 0) && (
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
        )}
        {!archiveOnly && !hasSets && (
          <p>
            {board.closed
              ? 'No recorded sets in this view.'
              : 'Results appear here once confirmed.'}
          </p>
        )}
        {(!archiveOnly || hasSets) && (
          <p className="event-live-note">
            Set results are shown as recorded. They do not imply final tournament placements.
          </p>
        )}
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
                      <li key={result.entryKey}>
                        <span>{result.place}</span> {result.alias}
                      </li>
                    ))}
                  </ol>
                  <ResultGraphic
                    title={`${data.plan.name} · ${pool.title}`}
                    context={{
                      eventName: data.plan.name,
                      eventDate: data.plan.eventDate,
                      format: data.plan.competitionFormat ?? 'singles',
                      scopeLabel: pool.title,
                      kind: 'pool',
                      source: { planId: data.plan.id },
                    }}
                    results={pool.results}
                  />
                </article>
              ))}
            </div>
          </section>
        )}
        {resultsSlug && (
          <p>
            <Button asChild>
              <a href={`/events/${encodeURIComponent(resultsSlug)}`}>
                {data.plan.historicalResultsSlug
                  ? 'View historical results →'
                  : 'Final standings and club results →'}
              </a>
            </Button>
          </p>
        )}
        {prizes.length > 0 && (
          <>
            {(!archiveOnly || hasResults) && <h2>{board.closed ? 'Prizes' : 'On the line'}</h2>}
            <div className="event-results-grid">
              {prizes.map((prize) => (
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
      {!runEnded &&
        board.activePools &&
        (board.activeBrackets || (player && board.resolvedPools)) && (
          <p className="card player-event-stage-note">
            {player && board.resolvedPools
              ? 'Other pool sets are still in progress.'
              : 'Brackets and pools are both in progress.'}
          </p>
        )}
      {sectionOrder.map((section) => (
        <div className="player-event-board-group" key={section}>
          {sections[section]}
        </div>
      ))}
    </>
  );
}

function PlayerHubBracketSection({
  data,
  board,
  player,
  runEnded,
  archiveOnly,
  archiveEntry,
}: {
  data: PublicEventSnapshot;
  board: ReturnType<typeof playerHubView>;
  player: string;
  runEnded: boolean;
  archiveOnly: boolean;
  archiveEntry: boolean;
}) {
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
      title={archiveOnly && !board.nativeBrackets.length ? 'Brackets on Challonge' : undefined}
      brackets={board.nativeBrackets}
      matches={data.matches}
      entrants={data.entrants}
      linked={board.linked}
      recordedOnly={board.closed}
      graphicContext={{
        eventName: data.plan.name,
        eventDate: formatDate(data.plan.eventDate),
        format: data.plan.competitionFormat ?? 'singles',
        structure: data.plan.structure,
        state: board.closed ? 'closed' : data.plan.drawPaused ? 'paused' : 'published',
      }}
    />
  );
  const recordedPath = board.closed || runEnded;
  const qualifying = !recordedPath && board.pendingBrackets.length > 0;
  const pendingFinals = (recordedPath ? [] : (data.pendingFinals ?? [])).flatMap((field) => {
    if (!player) return [field];
    if (board.assignedBrackets.length) return [];
    const slots = field.slots.filter((slot) =>
      slot.entrantId
        ? board.identities.has(slot.entrantId)
        : board.ownPools.has(`${slot.division}:${slot.poolIndex}`),
    );
    return slots.length ? [{ ...field, slots }] : [];
  });
  return (
    <section
      id="event-brackets"
      aria-label="Brackets"
      data-archive-entry={archiveEntry || undefined}
      tabIndex={archiveEntry ? -1 : undefined}
      className="app-event-board player-event-board-section"
    >
      {player && board.nativeBrackets.length > 0 ? (
        <>
          <h2>{qualifying ? 'Finals qualification' : 'Your bracket path'}</h2>
          {qualifying ? (
            <p className="event-live-note">
              Your pool order will determine your bracket. These draws show reserved pool places;
              your finals opponents are not confirmed yet.
            </p>
          ) : (
            <p className="event-live-note">
              {recordedPath
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
          {!recordedPath && !path.length && !qualifying && (
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
      {!pendingFinals.length && !board.hasBrackets && (
        <>
          <h2>Brackets</h2>
          <p>
            {data.plan.structure === 'round_robin'
              ? 'This event uses pool standings to decide the result; there is no finals bracket.'
              : recordedPath
                ? `No bracket is recorded for this ${player ? 'player' : 'event'}.`
                : player
                  ? 'Brackets will appear here for this player when the organisers publish the draw. Pool results do not imply a bracket seed.'
                  : 'Brackets will appear here when the organisers publish the draw. Pool results do not imply a bracket seed.'}
          </p>
        </>
      )}
    </section>
  );
}
