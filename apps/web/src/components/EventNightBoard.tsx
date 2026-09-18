import type { LiveMatch } from '../lib/eventDisplay';
import { poolStandings } from '../lib/eventQueue';
import { CharacterIcons } from './CharacterIcons';

export type DisplayStation = { id: string; name: string; status?: 'free' | 'occupied'; currentMatchId?: string | null };
export type PoolSchedule = { division: string; poolIndex: number; active: boolean; stationIds: string[] };
export type NativeBracketView = { id: string; division: string; stage: string; entrantIds: string[]; complete: boolean; winnerId: string | null; standings: { playerId: string; place: number }[] };
export function EventStations({ stations, matches }: { stations: DisplayStation[]; matches: LiveMatch[] }) {
  return <section className="event-stations"><h2>Stations</h2>{stations.length ? <div className="event-station-grid">{stations.map(station => {
    const match = matches.find(item => station.currentMatchId ? item.id === station.currentMatchId : item.stationId === station.id && item.status === 'playing');
    const occupied = station.status === 'occupied' || !!match;
    return <article className={`event-station ${occupied ? 'is-occupied' : ''}`} key={station.id}><div><h3>{station.name}</h3><span>{occupied ? 'Playing now' : 'Free'}</span></div>{match ? <p>{match.player1Name} <strong>{match.score1 ?? '–'} : {match.score2 ?? '–'}</strong> {match.player2Name}</p> : <p>Ask a TO for your next match.</p>}</article>;
  })}</div> : <p className="event-live-note">Station assignments will appear here when the organisers add setups.</p>}</section>;
}
export function EventPools({ matches, schedules, stations }: { matches: LiveMatch[]; schedules: PoolSchedule[]; stations: DisplayStation[] }) {
  const pools = poolStandings(matches);
  if (!pools.length) return null;
  return <section className="event-pool-progress"><h2>Pool progress & standings</h2><p className="event-live-note">These are live set records, ordered by wins then game difference. Ties and final places are confirmed by the organisers below.</p><div className="event-results-grid">{pools.map(pool => {
    const schedule = schedules.find(item => item.division === pool.division && item.poolIndex === pool.poolIndex);
    const names = schedule?.stationIds.map(id => stations.find(item => item.id === id)?.name).filter(Boolean) ?? [];
    return <article className="event-pool" key={`${pool.division}:${pool.poolIndex}`}><header><h3>{pool.division} · Pool {String.fromCharCode(65 + pool.poolIndex)}</h3><span>{schedule?.active === false ? 'On hold' : pool.complete === pool.total ? 'All sets recorded' : 'Active'}</span></header><p>{pool.complete} / {pool.total} sets recorded{names.length ? ` · ${names.join(', ')}` : ' · Any available station'}</p><progress value={pool.complete} max={Math.max(1, pool.total)} aria-label={`${pool.division} Pool ${String.fromCharCode(65 + pool.poolIndex)} progress`} /><div className="event-pool-table"><table><thead><tr><th>Player</th><th><abbr title="Sets won">W</abbr></th><th><abbr title="Sets lost">L</abbr></th><th><abbr title="Game difference">+/−</abbr></th><th><abbr title="Matches remaining">Left</abbr></th></tr></thead><tbody>{pool.players.map(player => {
      const match = matches.find(item => item.player1Id === player.id || item.player2Id === player.id);
      const characters = match?.player1Id === player.id ? match.player1Characters : match?.player2Characters;
      return <tr key={player.id}><th scope="row">{player.name}<CharacterIcons slugs={characters ?? []} /></th><td>{player.wins}</td><td>{player.losses}</td><td>{player.differential > 0 ? '+' : ''}{player.differential}</td><td>{player.remaining}</td></tr>;
    })}</tbody></table></div></article>;
  })}</div></section>;
}
export function EventBrackets({ brackets, matches, entrants, linked }: { brackets: NativeBracketView[]; matches: LiveMatch[]; entrants: { id: string; name: string }[]; linked: { division: string; stage: string; slug: string | null }[] }) {
  if (!brackets.length && !linked.some(item => item.slug)) return null;
  const names = new Map(entrants.map(player => [player.id, player.name]));
  const labels = new Map(matches.map(match => [match.id, match.label]));
  return <section className="event-brackets"><h2>Brackets</h2>{brackets.map(bracket => {
    const games = matches.filter(match => match.nativeBracketId === bracket.id);
    const rounds = [...new Set(games.map(match => match.nativeRound ?? 0))].sort((a, b) => a - b);
    return <article className="event-bracket" key={bracket.id}><header><h3>{bracket.division} · {bracket.stage === 'main' ? 'Championship' : 'Consolation'}</h3>{bracket.complete && bracket.winnerId && <p>Winner · <strong>{names.get(bracket.winnerId) ?? 'Player'}</strong></p>}</header><div className="event-bracket-rounds" role="region" aria-label={`${bracket.division} ${bracket.stage} bracket rounds`} tabIndex={0}>{rounds.map((round, index) => <section className="event-bracket-round" key={round}><h4>{index === rounds.length - 1 ? 'Final' : index === rounds.length - 2 ? 'Semi-finals' : `Round ${index + 1}`}</h4>{games.filter(match => match.nativeRound === round).sort((a, b) => (a.nativeSlot ?? 0) - (b.nativeSlot ?? 0)).map(match => <article className={`event-bracket-match ${match.status === 'playing' ? 'is-playing' : ''}`} key={match.id}><small>{match.label} · {match.status === 'playing' ? 'Playing now' : match.status === 'complete' ? match.outcome === 'bye' ? 'Bye' : 'Final result' : 'Upcoming'}</small>{[{ id: match.player1Id, name: match.player1Name, score: match.score1, parent: match.parent1MatchId, characters: match.player1Characters }, { id: match.player2Id, name: match.player2Name, score: match.score2, parent: match.parent2MatchId, characters: match.player2Characters }].map((player, side) => <div className={player.id && match.winnerId === player.id ? 'is-winner' : ''} key={side}><span>{player.id ? player.name : player.parent ? `Winner of ${labels.get(player.parent) ?? 'previous match'}` : match.outcome === 'bye' ? 'Bye' : 'To be decided'}<CharacterIcons slugs={player.characters ?? []} /></span><b>{player.score ?? '–'}</b></div>)}</article>)}</section>)}</div>{bracket.complete && bracket.standings.length > 0 && <p className="event-live-note">Final placings: {bracket.standings.map(place => `${place.place}. ${names.get(place.playerId) ?? 'Player'}`).join(' · ')}</p>}</article>;
  })}{linked.some(item => item.slug) && <nav className="event-bracket-links" aria-label="Challonge brackets">{linked.filter(item => item.slug).map(item => <a className="btn" href={`https://challonge.com/${encodeURIComponent(item.slug!)}`} target="_blank" rel="noreferrer" key={`${item.division}:${item.stage}`}>{item.division} · {item.stage === 'main' ? 'Groups & championship' : 'Consolation'} ↗</a>)}</nav>}</section>;
}
