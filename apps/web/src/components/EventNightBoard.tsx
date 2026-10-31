import { EventBracketLane } from './EventBracketLane';
import { Progress } from './ui/Progress';
import { liveBracketLanes } from '../lib/eventBracket';
import type { LiveMatch, PoolQualifierSlot } from '../lib/eventDisplay';
import { poolStandings } from '../lib/eventQueue';
import { CharacterIcons } from './CharacterIcons';

export type DisplayStation = {
  id: string;
  name: string;
  status?: 'free' | 'occupied';
  currentMatchId?: string | null;
};
export type PoolSchedule = {
  division: string;
  poolIndex: number;
  active: boolean;
  stationIds: string[];
};
export type NativeBracketView = {
  id: string;
  division: string;
  stage: string;
  entrantIds: string[];
  complete: boolean;
  winnerId: string | null;
  standings: { playerId: string; place: number }[];
  qualifierSlots?: PoolQualifierSlot[];
};
export function EventStations({
  stations,
  matches,
}: {
  stations: DisplayStation[];
  matches: LiveMatch[];
}) {
  return (
    <section className="event-stations">
      <h2>Stations</h2>
      {stations.length ? (
        <div className="event-station-grid">
          {stations.map((station) => {
            const match = matches.find((item) =>
              station.currentMatchId
                ? item.id === station.currentMatchId
                : item.stationId === station.id && item.status === 'playing',
            );
            const occupied = station.status === 'occupied' || Boolean(match);
            return (
              <article
                className={`event-station ${occupied ? 'is-occupied' : ''}`}
                key={station.id}
              >
                <div>
                  <h3>{station.name}</h3>
                  <span>{occupied ? 'Playing now' : 'Free'}</span>
                </div>
                {match ? (
                  <p>
                    {match.player1Name}{' '}
                    <strong>
                      {match.score1 ?? '–'} : {match.score2 ?? '–'}
                    </strong>{' '}
                    {match.player2Name}
                  </p>
                ) : (
                  <p>Ask a TO for your next match.</p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="event-live-note">
          Station assignments will appear here when the organisers add setups.
        </p>
      )}
    </section>
  );
}
export function EventPools({
  matches,
  schedules,
  stations,
}: {
  matches: LiveMatch[];
  schedules: PoolSchedule[];
  stations: DisplayStation[];
}) {
  const pools = poolStandings(matches);
  if (!pools.length) return null;
  return (
    <section className="event-pool-progress">
      <h2>Pool progress & standings</h2>
      <p className="event-live-note">
        These are live set records, ordered by wins then game difference. Ties and final places are
        confirmed by the organisers below.
      </p>
      <div className="event-results-grid">
        {pools.map((pool) => {
          const schedule = schedules.find(
            (item) => item.division === pool.division && item.poolIndex === pool.poolIndex,
          );
          const names =
            schedule?.stationIds
              .map((id) => stations.find((item) => item.id === id)?.name)
              .filter(Boolean) ?? [];
          return (
            <article className="event-pool" key={`${pool.division}:${pool.poolIndex}`}>
              <header>
                <h3>
                  {pool.division} · Pool {String.fromCharCode(65 + pool.poolIndex)}
                </h3>
                <span>
                  {schedule?.active === false
                    ? 'On hold'
                    : pool.complete === pool.total
                      ? 'All sets recorded'
                      : 'Active'}
                </span>
              </header>
              <p>
                {pool.complete} / {pool.total} sets recorded
                {names.length ? ` · ${names.join(', ')}` : ' · Any available station'}
              </p>
              <Progress
                value={pool.complete}
                max={Math.max(1, pool.total)}
                label={`${pool.division} Pool ${String.fromCharCode(65 + pool.poolIndex)} progress`}
              />
              <div className="event-pool-table">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>
                        <abbr title="Sets won">W</abbr>
                      </th>
                      <th>
                        <abbr title="Sets lost">L</abbr>
                      </th>
                      <th>
                        <abbr title="Game difference">+/−</abbr>
                      </th>
                      <th>
                        <abbr title="Matches remaining">Left</abbr>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.players.map((player) => {
                      const match = matches.find(
                        (item) => item.player1Id === player.id || item.player2Id === player.id,
                      );
                      const characters =
                        match?.player1Id === player.id
                          ? match.player1Characters
                          : match?.player2Characters;
                      return (
                        <tr key={player.id}>
                          <th scope="row">
                            {player.name}
                            <CharacterIcons slugs={characters ?? []} />
                          </th>
                          <td>{player.wins}</td>
                          <td>{player.losses}</td>
                          <td>
                            {player.differential > 0 ? '+' : ''}
                            {player.differential}
                          </td>
                          <td>{player.remaining}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
export function EventBrackets({
  brackets,
  matches,
  entrants,
  linked,
}: {
  brackets: NativeBracketView[];
  matches: LiveMatch[];
  entrants: { id: string; name: string }[];
  linked: { division: string; stage: string; slug: string | null }[];
}) {
  if (!brackets.length && !linked.some((item) => item.slug)) return null;
  const names = new Map(entrants.map((player) => [player.id, player.name]));
  const labels = new Map(matches.map((match) => [match.id, match.label]));
  return (
    <section className="event-brackets live-event-brackets">
      <h2>Brackets</h2>
      {brackets.map((bracket) => {
        const games = matches.filter((match) => match.nativeBracketId === bracket.id);
        return (
          <article className="event-bracket" key={bracket.id}>
            <header>
              <h3>
                {bracket.division} · {bracket.stage === 'main' ? 'Championship' : 'Consolation'}
              </h3>
              {bracket.qualifierSlots?.some((slot) => slot.status !== 'resolved') && (
                <p className="event-live-note">
                  Qualification is pending. Pool-place labels reserve draw positions; they do not
                  assign a player or award a bye.
                </p>
              )}
              {bracket.complete && (
                <p>
                  {bracket.winnerId ? (
                    <>
                      Winner · <strong>{names.get(bracket.winnerId) ?? 'Player'}</strong>
                    </>
                  ) : bracket.entrantIds.length ? (
                    'No champion — remaining entrants withdrew; no contest.'
                  ) : (
                    'Empty bracket — no entrants.'
                  )}
                </p>
              )}
            </header>
            {bracket.complete && bracket.entrantIds.length === 1 && bracket.winnerId && (
              <p className="event-live-note">One entrant advances without a played set.</p>
            )}
            {!games.length &&
              !(bracket.complete && bracket.entrantIds.length === 1 && bracket.winnerId) && (
                <p className="event-live-note">
                  {bracket.complete
                    ? 'No sets in this bracket.'
                    : 'The draw will appear when the organisers publish the bracket.'}
                </p>
              )}
            {new Set(games.map((match) => match.nativeRound)).size > 1 && (
              <p className="event-live-note">Scroll sideways to follow later rounds.</p>
            )}
            {liveBracketLanes(games).map((lane) => (
              <EventBracketLane
                key={lane.key}
                matches={lane.matches}
                lane={lane.key}
                title={lane.title}
                label={`${bracket.division} ${bracket.stage} ${lane.title || 'bracket rounds'}`}
                labels={labels}
              />
            ))}
            {bracket.complete && bracket.standings.length > 0 && (
              <p className="event-live-note">
                Final placings:{' '}
                {bracket.standings
                  .map((place) => `${place.place}. ${names.get(place.playerId) ?? 'Player'}`)
                  .join(' · ')}
              </p>
            )}
          </article>
        );
      })}
      {linked.some((item) => item.slug) && (
        <nav className="event-bracket-links" aria-label="Challonge brackets">
          {linked
            .filter((item) => item.slug)
            .map((item) => (
              <a
                className="btn"
                href={`https://challonge.com/${encodeURIComponent(item.slug!)}`}
                target="_blank"
                rel="noreferrer"
                key={`${item.division}:${item.stage}`}
              >
                {item.division} · {item.stage === 'main' ? 'Groups & championship' : 'Consolation'}{' '}
                ↗
              </a>
            ))}
        </nav>
      )}
    </section>
  );
}
