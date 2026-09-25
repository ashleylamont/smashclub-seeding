import { useState } from 'react';
import { findEventPlayers, playerEventStatus, type FinderData, type FinderMatch } from '../../lib/toPlayerFinder';
import { poolTitle } from '../../lib/poolFlow';
import './ToPlayerFinder.css';

export function ToPlayerFinder({ data, onMatch, onPool }: { data: FinderData; onMatch: (id: string) => void; onPool: (key: string) => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const results = findEventPlayers(data, query);
  const player = results.find(item => item.id === selected);
  const status = player ? playerEventStatus(data, player.id) : null;
  const matchLink = (match: FinderMatch, title: string) => <button className="btn btn-small" onClick={() => onMatch(match.id)}>{title}</button>;
  return <section className="card to-player-finder" aria-labelledby="to-player-finder-heading">
    <div><h3 id="to-player-finder-heading">Find a player</h3><p className="muted">Their match, pool and next station call, in one place.</p></div>
    <label>Player name<input className="input" type="search" autoComplete="off" placeholder="Search event entrants" value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} /></label>
    {query.trim() && !player && <div className="to-player-results" aria-live="polite">
      {!results.length && <p>No event players match that name.</p>}
      {results.slice(0, 12).map(item => { const info = playerEventStatus(data, item.id); return <button className="to-player-result" key={item.id} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><span>{info.pools.map(pool => poolTitle(pool.key)).join(' · ') || 'No pool matches yet'}{info.withdrawn ? ' · Withdrawn' : info.playing.length ? info.closed ? ' · Last recorded playing' : ' · Playing' : ''}</span>{results.filter(result => result.name === item.name).length > 1 && <small>Player ID …{item.id.slice(-8)}</small>}</button>; })}
      {results.length > 12 && <p>{results.length} matches. Keep typing to narrow the list.</p>}
    </div>}
    {player && status && <div className="to-player-detail">
      <div className="to-player-title"><h4>{player.name}</h4><button className="btn btn-small" onClick={() => setSelected(null)}>Change player</button></div>
      {status.closed && <p className="to-player-alert">Event closed · these are the last recorded assignments.</p>}
      {status.withdrawn && <p className="to-player-alert">Withdrawn from this event. Outstanding matches may still need a TO forfeit decision.</p>}
      {status.playing.map(match => <div className="to-player-call" key={match.id}><strong>{status.closed ? 'Last recorded match' : 'Playing'} · {data.stations.find(station => station.id === match.stationId)?.name ?? 'No station assigned'}</strong><p>{match.player1Name} {match.score1 ?? 0} – {match.score2 ?? 0} {match.player2Name}</p>{matchLink(match, 'Open current match')}</div>)}
      {status.next.map(({ match, station }) => <div className="to-player-call" key={match.id}><strong>Play next · {station.name}</strong><p>vs {match.player1Id === player.id ? match.player2Name : match.player1Name}</p>{matchLink(match, 'Open next match')}</div>)}
      {!status.closed && !status.withdrawn && !status.playing.length && !status.next.length && <p className="to-player-alert">{!status.matches.length ? 'No matches prepared for this entrant yet.' : !status.outstanding.length ? 'No remaining prepared matches. Later brackets may still need to be generated.' : 'Not currently playing. No station is calling this player yet.'}</p>}
      <div className="to-player-pools">{status.pools.map(pool => <div key={pool.key}><button className="to-player-pool-link" onClick={() => onPool(pool.key)}>{poolTitle(pool.key)}</button><span>{pool.remaining === 0 ? 'Pool matches resolved' : pool.held ? 'On hold for a later wave' : 'Pool open'} · {pool.stationNames.join(', ') || 'No dedicated stations'}</span></div>)}</div>
      <p className="muted">{status.completed} finished · {status.outstanding.length} unresolved{status.noContests > 0 && ` · ${status.noContests} no contests`} · Counts cover prepared matches only.</p>
      {status.pending.length > 0 && <p className="to-player-alert">{status.pending.length} score {status.pending.length === 1 ? 'submission awaits' : 'submissions await'} TO review. <a href="#score-submissions">Review score submissions</a></p>}
      {status.outstanding.length > 0 && <details><summary>Remaining matches and waiting reasons ({status.outstanding.length})</summary><ul className="to-player-matches">{status.outstanding.map(match => <li key={match.id}><strong>vs {match.player1Id === player.id ? match.player2Name : match.player1Name}</strong><small>{match.label}</small><p>{match.status === 'playing' ? status.closed ? 'Last recorded as playing' : 'Playing now' : match.availability.reasons.map(reason => reason.message).join(' ') || 'Players are available; follow the station queue for the next call.'}</p>{matchLink(match, 'Open match')}</li>)}</ul></details>}
      <small className="muted">Station assignments show match activity, not physical attendance.</small>
    </div>}
  </section>;
}
