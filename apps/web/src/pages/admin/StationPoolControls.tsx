import { useState } from 'react';
import { trpc } from '../../lib/trpc';
import { poolStandings } from '../../lib/eventQueue';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;

export function StationPoolControls({ data, disabled, act, onPool }: { data: Overview; disabled: boolean; act: Action; onPool: (key: string) => void }) {
  const [stationName, setStationName] = useState('');
  const [stationCount, setStationCount] = useState(4);
  const pools = poolStandings(data.matches);
  return <>
    <section className="card"><div className="ops-section-heading"><h3>Stations</h3><span>{data.stations.filter(station => station.status === 'free').length} of {data.stations.length} free</span></div>
      <div className="ops-station-board">{data.stations.map(station => {
        const match = data.matches.find(match => match.id === station.currentMatchId);
        return <article className={`ops-station-tile ${match ? 'is-playing' : 'is-free'}`} key={station.id}>
          <strong>{station.name}</strong><span className="chip">{match ? 'Playing now' : 'Free'}</span>
          {match ? <><p>{match.player1Name} <b>{match.score1 ?? 0}–{match.score2 ?? 0}</b> {match.player2Name}</p><small>{match.label}</small></> : <p>Available for the next match</p>}
          <a href={`/overlay/${data.plan.id}?station=${encodeURIComponent(station.id)}`} target="_blank" rel="noreferrer">Open this station’s display ↗</a>
        </article>;
      })}</div>
      {!data.stations.length && <p>Add the stations available tonight. Matches can then be assigned to a free station.</p>}
      <details className="ops-station-settings"><summary>Add stations</summary>
        <form onSubmit={event => { event.preventDefault(); void act(async () => { await trpc.eventOps.saveStation.mutate({ planId: data.plan.id, name: stationName }); setStationName(''); }, 'Station added'); }}><label>Station name<input className="input" value={stationName} onChange={event => setStationName(event.target.value)} placeholder="Main stage / Station A" maxLength={60} required /></label><button className="btn" disabled={disabled}>Add named station</button></form>
        <form onSubmit={event => { event.preventDefault(); void act(async () => {
          const existing = new Set(data.stations.map(station => station.name.toLowerCase()));
          let number = 1;
          for (let added = 0; added < stationCount; added++) {
            while (existing.has(`station ${number}`)) number++;
            await trpc.eventOps.saveStation.mutate({ planId: data.plan.id, name: `Station ${number++}` });
          }
        }, `${stationCount} stations added`); }}><label>Number of stations to add<input className="input" type="number" min={1} max={32} value={stationCount} onChange={event => setStationCount(Number(event.target.value))} required /></label><button className="btn" disabled={disabled}>Add numbered stations</button></form>
      </details>
    </section>
    {pools.length > 0 && <section className="card"><h3>Pool queues and stations</h3><p className="muted">Choose which pools can play now and which stations they use. Pools scheduled for later stay out of the ready queue. An empty station selection allows any station.</p>
      <div className="ops-pool-controls">{pools.map(pool => {
        const schedule = data.poolSchedules.find(schedule => schedule.division === pool.division && schedule.poolIndex === pool.poolIndex);
        const playing = data.matches.filter(match => match.stage === 'group' && match.division === pool.division && match.poolIndex === pool.poolIndex && match.status === 'playing').length;
        return <PoolSchedule key={`${pool.division}:${pool.poolIndex}:${schedule?.revision ?? 0}`} planId={data.plan.id} pool={pool} schedule={schedule} stations={data.stations} playing={playing} disabled={disabled} act={act} onView={() => onPool(`${pool.division}:${pool.poolIndex}`)} />;
      })}</div>
    </section>}
  </>;
}

function PoolSchedule({ planId, pool, schedule, stations, playing, disabled, act, onView }: { planId: string; pool: ReturnType<typeof poolStandings>[number]; schedule: Overview['poolSchedules'][number] | undefined; stations: Overview['stations']; playing: number; disabled: boolean; act: Action; onView: () => void }) {
  const [active, setActive] = useState(schedule?.active ?? true);
  const [selected, setSelected] = useState(schedule?.stationIds ?? []);
  const done = pool.complete === pool.total;
  const label = `${pool.division === 'upper' ? 'Upper' : 'Lower'} Pool ${String.fromCharCode(65 + pool.poolIndex)}`;
  const changed = active !== (schedule?.active ?? true) || [...selected].sort().join() !== [...(schedule?.stationIds ?? [])].sort().join();
  return <article className="ops-pool-schedule"><div className="ops-section-heading"><h4>{label}</h4><span className="chip">{done ? 'Finished' : !schedule?.active && schedule ? 'Scheduled later' : playing ? 'Playing now' : pool.complete ? 'In progress' : 'Ready to begin'}</span></div>
    <p>{pool.complete} / {pool.total} matches complete{playing > 0 && ` · ${playing} playing`}</p>
    <label className="ops-check"><input type="checkbox" checked={active} disabled={disabled || done} onChange={event => setActive(event.target.checked)} />Allow this pool to play now</label>
    <fieldset disabled={disabled || done}><legend>Stations for {label}</legend>{stations.map(station => <label className="ops-check" key={station.id}><input type="checkbox" checked={selected.includes(station.id)} onChange={event => setSelected(event.target.checked ? [...selected, station.id] : selected.filter(id => id !== station.id))} />{station.name}</label>)}</fieldset>
    <div className="ops-match-actions"><button className="btn btn-small" disabled={disabled || done || !changed} onClick={() => void act(() => trpc.eventOps.configurePool.mutate({ planId, division: pool.division as 'upper' | 'lower', poolIndex: pool.poolIndex, active, stationIds: selected, expectedRevision: schedule?.revision ?? 0 }), 'Pool queue updated')}>Save pool settings</button><button className="btn btn-small" onClick={onView}>View pool matches</button></div>
  </article>;
}
