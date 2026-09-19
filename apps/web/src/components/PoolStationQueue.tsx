import { matchesPool, poolKey, poolPath, poolPolicy, poolTitle, stationPreview, type PoolFlowData, type StartPoolMatch } from '../lib/poolFlow';
import { CharacterIcons } from './CharacterIcons';
import './PoolStationQueue.css';

export function PoolFilter({ data, value, onChange }: { data: Pick<PoolFlowData, 'matches'>; value: string; onChange: (value: string) => void }) {
  const keys = [...new Set(data.matches.map(poolKey).filter((key): key is string => !!key))].sort();
  if (!keys.length) return null;
  return <label className="pool-flow-filter">Your pool<select className="select" value={value} onChange={event => onChange(event.target.value)}><option value="">All pools & finals</option>{value && !keys.includes(value) && <option value={value}>{poolTitle(value)} · unavailable</option>}{keys.map(key => <option key={key} value={key}>{poolTitle(key)}</option>)}</select></label>;
}
export function PoolStationQueue({ data, selectedPool = '', onStart, onReport, disabled = false, pendingMatchId }: { data: PoolFlowData; selectedPool?: string; onStart?: (input: StartPoolMatch) => void; onReport?: (matchId: string) => void; disabled?: boolean; pendingMatchId?: string | null }) {
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const queues = data.stationQueues ?? [];
  const selectedSchedule = data.poolSchedules.find(pool => `${pool.division}:${pool.poolIndex}` === selectedPool);
  const visible = data.stations.filter(station => {
    if (!selectedPool) return true;
    const schedule = data.poolSchedules.find(pool => `${pool.division}:${pool.poolIndex}` === selectedPool);
    const queue = queues.find(item => item.stationId === station.id);
    return schedule?.stationIds.includes(station.id) || queue?.poolKey === selectedPool || data.matches.some(match => match.id === queue?.nextMatchId && matchesPool(match, selectedPool)) || queue?.upcoming.some(item => data.matches.some(match => match.id === item.matchId && matchesPool(match, selectedPool))) || data.matches.some(match => match.id === queue?.currentMatchId && matchesPool(match, selectedPool));
  });
  return <section className="pool-flow-stations" aria-label="Pool station queues"><div className="pool-flow-heading"><h2>Find your station</h2><span>{selectedPool ? poolTitle(selectedPool) : 'Playing now · play next'}</span></div>
    {selectedSchedule?.active === false && <p className="pool-flow-selected-note">{poolTitle(selectedPool)} is scheduled for a later wave. These stations may be serving another pool now; wait for your pool to be called.</p>}
    <p className="pool-flow-note">Wait for the station and both players to be free. Coming up is a suggested order; it can change as matches finish.</p>
    <div className="pool-flow-grid">{visible.map(station => {
      const queue = queues.find(item => item.stationId === station.id);
      const current = data.matches.find(match => match.id === (queue?.currentMatchId ?? station.currentMatchId) || !queue && match.status === 'playing' && match.stationId === station.id);
      const next = queue?.nextMatchId ? data.matches.find(match => match.id === queue.nextMatchId && matchesPool(match, selectedPool)) : undefined;
      const upcoming = queue ? stationPreview(queue, data.matches, 4).filter(match => match.id !== next?.id && matchesPool(match, selectedPool)).slice(0, 2) : [];
      const policy = next && poolPolicy(data, next);
      return <article className={`pool-flow-station${current ? ' is-playing' : ''}`} key={station.id}><header><h3>{station.name}</h3><span>{current ? 'Playing now' : closed ? 'Finished' : 'Free'}</span></header><p className="pool-flow-bank">{queue?.poolKey ? `${poolTitle(queue.poolKey)} · station bank` : 'Open station · no active pool reservation'}</p>
        {current ? <div className="pool-flow-current"><strong>{current.player1Name}<CharacterIcons slugs={current.player1Characters ?? []} /></strong><b>{current.score1 ?? 0} – {current.score2 ?? 0}</b><strong>{current.player2Name}<CharacterIcons slugs={current.player2Characters ?? []} /></strong><small>{current.label}</small>{onReport && matchesPool(current, selectedPool) && <button className="btn btn-small" disabled={disabled} onClick={() => onReport(current.id)}>Report this result</button>}</div> : <p className="pool-flow-note">{closed ? 'The event has ended.' : next ? 'Both players can come over now.' : queue?.waitingReason ?? 'Waiting for the next match.'}</p>}
        {next && !closed && <div className="pool-flow-next"><small>PLAY NEXT</small><strong>{next.player1Name} <i>vs</i> {next.player2Name}</strong><span>{next.label}</span>{onStart && policy?.selfRun && <button className="btn btn-primary" disabled={disabled || !!pendingMatchId || !!current || next.status !== 'ready'} onClick={() => onStart({ matchId: next.id, stationId: station.id, expectedRevision: next.revision })}>{pendingMatchId === next.id ? 'Starting…' : 'We’re here — start match'}</button>}{!onStart && <a href={poolPath(`/play/${data.plan.id}`, poolKey(next) ?? '')}>Open pool & report →</a>}{onReport && !policy?.selfRun && <button className="btn btn-small" disabled={disabled} onClick={() => onReport(next.id)}>Report a played result</button>}{policy?.selfRun && <p className="pool-flow-note">{data.settings?.scoreReportingMode === 'approve_unless_disputed' ? 'Start here. Results advance immediately; later disagreements go to TO review.' : policy.autoAcceptScores ? 'Start here, then the submitted result is confirmed immediately.' : 'Start here. Results still need TO approval.'}</p>}</div>}
        {upcoming.length > 0 && <div className="pool-flow-upcoming"><small>COMING UP · ORDER MAY CHANGE</small><ol>{upcoming.map(match => <li key={match.id}><span>{match.player1Name} vs {match.player2Name}</span><small>{match.label}</small></li>)}</ol></div>}
      </article>;
    })}</div>{!visible.length && <p className="pool-flow-note">{selectedPool ? 'No station is assigned to this pool yet. Ask a TO where to play.' : 'Station assignments will appear here.'}</p>}
  </section>;
}
export function PoolRoundSchedule({ data, selectedPool = '' }: { data: PoolFlowData; selectedPool?: string }) {
  const groups = (data.poolRounds ?? []).filter(pool => !selectedPool || pool.poolKey === selectedPool);
  const names = new Map(data.matches.flatMap(match => [[match.player1Id, match.player1Name], [match.player2Id, match.player2Name]] as const));
  if (!groups.length) return null;
  return <section className="pool-flow-rounds"><div className="pool-flow-heading"><h2>Pool rounds</h2><span>Everyone meets once</span></div><p className="pool-flow-note">Follow the station queue above. These rounds show the pairings and who rests; they are not start times.</p>{groups.map(pool => <details className="pool-flow-round-group" key={pool.poolKey}><summary>{poolTitle(pool.poolKey)} <span>{pool.rounds.length} rounds</span></summary><a className="pool-flow-share" href={poolPath(`/live/${data.plan.id}`, pool.poolKey)}>Open this pool’s board →</a><div className="pool-flow-round-grid">{pool.rounds.map(round => <article key={round.round}><h3>Round {round.round}</h3><ul>{round.matchIds.map(id => { const match = data.matches.find(item => item.id === id); return match ? <li key={id}><span>{match.player1Name} vs {match.player2Name}</span><small>{match.status === 'complete' ? `${match.score1 ?? '–'}–${match.score2 ?? '–'} · complete` : match.status === 'playing' ? 'Playing now' : 'Upcoming'}</small></li> : null; })}</ul>{round.restingPlayerIds.length > 0 && <p>Resting: {round.restingPlayerIds.map(id => names.get(id) ?? 'Player').join(', ')}</p>}</article>)}</div></details>)}</section>;
}
