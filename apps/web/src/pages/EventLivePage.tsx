import { useEffect, useState, type CSSProperties } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import './EventLive.css';
import { NemesisMark } from '../components/NemesisMark';
import { CharacterIcons } from '../components/CharacterIcons';
import { OverlaySetup } from '../components/OverlaySetup';
import { EventPools, EventBrackets, type PoolSchedule, type NativeBracketView } from '../components/EventNightBoard';
import { PoolFilter, PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import { matchesPool, poolPath, stationPreview, usePoolFilter, type PoolFlowData } from '../lib/poolFlow';
import { ResultGraphic } from '../components/ResultGraphic';
import { GuestOverlayQr } from '../components/GuestOverlayQr';
import { BroadcastResults } from '../components/BroadcastResults';
import { recentResults } from '../lib/broadcastResults';
import { useGuestClock } from '../lib/guestReporting';
import { confirmedPoolGraphics } from '../lib/resultGraphic';

import { broadcastQueue, liveSections, overlayGeometry, type LiveMatch } from '../lib/eventDisplay';
export function EventLivePage() {
  const { planId } = useParams({ from: '/live/$planId' });
  return <EventDisplay key={planId} planId={planId} />;
}
export function EventOverlayPage() {
  const { planId } = useParams({ from: '/overlay/$planId' });
  return <EventDisplay key={planId} planId={planId} overlay />;
}
function EventDisplay({ planId, overlay = false }: { planId: string; overlay?: boolean }) {
  const query = useQuery({ queryKey: ['eventOps', 'snapshot', planId], queryFn: () => trpc.eventOps.snapshot.query({ planId }),
    refetchInterval: 5000, refetchIntervalInBackground: true, retry: 1 });
  const now = useGuestClock();
  const [selectedPool, setSelectedPool] = usePoolFilter();
  const [focus, setFocus] = useState(() => new URLSearchParams(window.location.search).get('station') ?? '');
  const changeFocus = (stationId: string) => {
    const url = new URL(window.location.href);
    if (stationId) url.searchParams.set('station', stationId); else url.searchParams.delete('station');
    window.history.replaceState(window.history.state, '', url);
    setFocus(stationId);
  };
  const guestInvitation = useQuery({ queryKey: ['overlayGuestInvitation', planId], queryFn: () => trpc.eventOps.guests.overlayInvitation.query({ planId }), enabled: overlay, refetchInterval: 10000, refetchIntervalInBackground: true, retry: false });
  const guestQr = !guestInvitation.isError && guestInvitation.data && Date.parse(guestInvitation.data.expiresAt) > now ? guestInvitation.data : null;
  useEffect(() => {
    if (!overlay) return;
    document.documentElement.classList.add('event-overlay-document');
    return () => document.documentElement.classList.remove('event-overlay-document');
  }, [overlay]);
  const publicationUnavailable = query.error instanceof TRPCClientError && ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(query.error.data?.code ?? '');
  if (!query.data || publicationUnavailable) return <div className={overlay ? 'event-display-message' : 'loading-text'} role="status">{query.isError ? 'This event is unavailable or has not been published.' : 'Loading live event…'}</div>;
  const data: typeof query.data & { poolSchedules?: PoolSchedule[]; nativeBrackets?: NativeBracketView[] } & Partial<Pick<PoolFlowData, 'stationQueues' | 'poolRounds'>> = query.data;
  const announcements = data.announcements.filter(item => !('expiresAt' in item) || !item.expiresAt || Date.parse(String(item.expiresAt)) > now);
  if (data.plan.historicalResultsSlug) return <section className={overlay ? 'event-display-message' : 'card section'}>
    <h1>{data.plan.name}</h1>
    <p>Historical event — results come from the imported brackets.</p>
    <a href={`/events/${encodeURIComponent(data.plan.historicalResultsSlug)}`}>View historical results →</a>
  </section>;
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const visibleMatches = data.matches.filter(match => matchesPool(match, selectedPool));
  const sections = liveSections(visibleMatches);
  const poolResults = confirmedPoolGraphics(data.placements.filter(place => !selectedPool || `${place.division}:${place.poolIndex}` === selectedPool), data.entrants);
  const geometry = overlayGeometry(window.location.search);
  const search = new URLSearchParams(window.location.search);
  const customGeometry = search.has('captureWidth') || search.has('captureHeight');
  const variables = (customGeometry ? { '--capture-width': `${geometry.width}vw`, '--capture-height': `${geometry.height}vh` } : {}) as CSSProperties;
  const station = (match: LiveMatch) => data.stations.find(s => s.id === match.stationId)?.name;
  const focusedStation = focus ? data.stations.find(item => item.id === focus || item.name.toLowerCase() === focus.toLowerCase()) : undefined;
  // Keep the broadcast tied to its station between sets, so the next pairing
  // comes from the same authoritative queue attendees use to start a match.
  const broadcastStation = focus ? focusedStation : data.stations.find(item => item.name.toLowerCase() === 'stage') ?? data.stations[0];
  const onStream = broadcastStation ? sections.playing.find(match => match.stationId === broadcastStation.id) : focus ? undefined : sections.playing[0];
  const stationQueue = data.stationQueues?.find(queue => queue.stationId === (broadcastStation?.id ?? onStream?.stationId));
  const onDeck = stationQueue ? stationPreview(stationQueue, data.matches).filter(match => matchesPool(match, selectedPool)) : focus ? [] : broadcastQueue(sections.ready);
  const provisionalNext = !!stationQueue && (!stationQueue.nextMatchId || !!stationQueue.currentMatchId);
  const otherPlaying = sections.playing.filter(match => match.id !== onStream?.id);
  const showName = data.plan.name.split(' · ')[0]!;
  if (overlay) return <div className="event-display event-overlay" style={variables}>
    <aside className={`broadcast-rail${guestQr ? ' has-guest-pass' : ''}`}>
      <div className="broadcast-club"><NemesisMark /><span>SMASH<br />CLUB</span></div>
      <div className="broadcast-identity"><span className="event-eyebrow">THE CLUB NIGHT</span><h1 title={data.plan.name}>{showName}</h1><span className="broadcast-edition">{data.plan.name.includes(' · ') ? data.plan.name.split(' · ').slice(1).join(' · ') : 'Find your rival.'}</span></div>
      <div className="broadcast-rail-rule"><span>{provisionalNext ? 'COMING UP' : 'PLAY NEXT'}</span><span>↗</span></div>
      <div className="broadcast-deck">{onDeck.length ? onDeck.slice(0, otherPlaying.length ? 1 : guestQr ? 2 : 3).map((match, index) => <article key={match.id}><span className="broadcast-queue-index">0{index + 1}</span><div><small>{match.division} / {match.stage === 'group' ? `POOL ${String.fromCharCode(65 + (match.poolIndex ?? 0))}` : match.stage}{stationQueue ? match.id === stationQueue.nextMatchId ? ' / PLAY NEXT' : ' / COMING UP · provisional' : ''}</small><strong>{match.player1Name || 'TBD'}</strong><span className="broadcast-versus">vs</span><strong>{match.player2Name || 'TBD'}</strong></div></article>) : <p className="broadcast-wait">Next challengers<br />coming up.</p>}</div>
      {otherPlaying.length > 0 && <div className="broadcast-other-stations" aria-label="Other stations playing"><span>OTHER STATIONS / PLAYING NOW</span>{otherPlaying.slice(0, guestQr ? 1 : 2).map(match => <article key={match.id}><small>{station(match) ?? 'Unassigned setup'}</small><strong>{match.player1Name} <b>{match.score1 ?? '–'}:{match.score2 ?? '–'}</b> {match.player2Name}</strong></article>)}{otherPlaying.length > (guestQr ? 1 : 2) && <small>+ {otherPlaying.length - (guestQr ? 1 : 2)} more playing</small>}</div>}
      <div className="broadcast-progress"><span>{selectedPool ? 'THIS POOL SO FAR' : 'THE NIGHT SO FAR'}</span><strong>{String(sections.complete.length).padStart(2, '0')}<i>/{String(sections.total).padStart(2, '0')}</i></strong><progress value={sections.complete.length} max={Math.max(1, sections.total)} aria-label="Sets completed" /><small>SETS IN THE BOOKS</small></div>
      {guestQr && <GuestOverlayQr planId={planId} invitation={guestQr} />}
      <span className="broadcast-rail-footer">GOOD GAMES. GREAT RIVALS.</span>
    </aside>
    <header className="broadcast-topline"><span><i /> {closed ? 'EVENT FINISHED' : onStream ? 'PLAYING NOW' : 'WAITING FOR A MATCH'}</span><span>{broadcastStation?.name ?? (onStream ? station(onStream) : null) ?? (focus ? 'Selected station' : 'Main broadcast')} / {onStream?.stage === 'group' ? 'ROUND ROBIN' : onStream?.stage?.toUpperCase() ?? 'NEXT SET SOON'}</span><span>nemesis.ashl.dev</span></header>
    <div className="broadcast-matchup" aria-label="Current match">
      <div className="broadcast-fighter broadcast-fighter-one"><span className="broadcast-side">P1</span><strong>{onStream?.player1Name || (closed ? 'GOOD GAMES' : 'NEXT CHALLENGER')}</strong><CharacterIcons slugs={onStream?.player1Characters ?? []} /><b>{onStream?.score1 ?? '—'}</b></div>
      <span className="broadcast-match-versus">VS</span>
      <div className="broadcast-fighter broadcast-fighter-two"><b>{onStream?.score2 ?? '—'}</b><strong>{onStream?.player2Name || (closed ? 'GOOD GAMES' : 'NEXT CHALLENGER')}</strong><CharacterIcons slugs={onStream?.player2Characters ?? []} /><span className="broadcast-side">P2</span></div>
    </div>
    <OverlaySetup stations={data.stations} focus={focusedStation?.id ?? focus} onFocus={changeFocus} />
    <footer className="broadcast-footer"><BroadcastResults key={planId} matches={data.matches} announcement={announcements[0]?.message ?? 'Grab a setup. Find your rival. Make it a good set.'} /></footer>
    {query.isError && <div className="broadcast-offline" role="status">Connection interrupted · last received scores</div>}
  </div>;
  return <div className="event-display event-board" style={variables}>
    <header className="event-live-header"><div className="event-board-brand"><NemesisMark /><span>SMASH CLUB<br />TOURNAMENT NIGHT</span></div><div className="event-board-title"><span className="event-eyebrow">FIND YOUR RIVAL.</span><h1>{data.plan.name}</h1></div>
      <div className="event-live-progress"><span>{selectedPool ? 'THIS POOL SO FAR' : 'THE NIGHT SO FAR'}</span><strong>{String(sections.complete.length).padStart(2, '0')}<span> / {sections.total}</span></strong><span>sets in the books</span><progress value={sections.complete.length} max={Math.max(1, sections.total)} aria-label="Sets completed" /></div>
    </header>
    <div className="event-connection" role="status"><span><i className="event-live-dot" />{sections.playing.length ? 'LIVE FROM THE CLUB' : 'THE EVENT BOARD'}</span><span>{query.isError ? 'Connection interrupted · showing last received results' : 'Results refresh every 5 seconds'}</span></div>
    {data.plan.resultsSlug && <p><a className="btn" href={`/events/${encodeURIComponent(data.plan.resultsSlug)}`}>Final standings and club results →</a></p>}
    <PoolFilter data={data} value={selectedPool} onChange={setSelectedPool} />
    <PoolStationQueue data={data} selectedPool={selectedPool} />
    <PoolRoundSchedule data={data} selectedPool={selectedPool} />
    <details className="event-extra-matches"><summary>More playing and ready matches</summary><div className="event-live-columns">
      <section className="event-now"><h2><span>01 /</span> Playing now <span>{sections.playing.length} LIVE</span></h2>
        {sections.playing.length ? sections.playing.map(match => <MatchCard key={match.id} match={match} station={station(match)} />) : <p className="event-empty">{closed ? <>The event has ended.<br /><strong>Good games, everyone.</strong></> : <>A little breather.<br /><strong>The next set is coming.</strong></>}</p>}
      </section>
      <section className="event-next"><h2><span>02 /</span> Ready to play <span>{sections.ready.length} READY</span></h2>
        {sections.ready.length ? sections.ready.slice(0, 6).map(match => <MatchCard key={match.id} match={match} station={station(match)} />) : <p className="event-empty">{closed ? "There are no more matches scheduled." : "Stay close. Your next matchup lands here."}</p>}
      </section>
    </div>
    </details>
    <aside className="event-announcements" aria-label="Announcements"><strong>FROM THE FLOOR ↗</strong><div>{announcements.length ? announcements.slice(0, 2).map(a => <p key={a.id}>{a.message}</p>) : <p>Good games. Great rivals. Welcome to the club.</p>}</div></aside>
    <>
      {!closed && data.settings.playerReports && <p><a className="btn" href={poolPath(`/play/${planId}`, selectedPool)}>Report your match score →</a></p>}
      <EventPools matches={visibleMatches} schedules={data.poolSchedules ?? []} stations={data.stations} />
      <EventBrackets brackets={data.nativeBrackets ?? []} matches={data.matches} entrants={data.entrants} linked={data.plan.bracketMode === 'native' ? [] : data.brackets} />
      <section className="event-recent"><h2>Recorded results</h2>{sections.complete.length ? <div className="event-results-grid">{recentResults(visibleMatches, 12).map(match => <MatchCard key={match.id} match={match} station={station(match)} />)}</div> : <p className="event-empty">Results appear here once confirmed.</p>}<p className="event-live-note">Set results are shown as recorded. They do not imply final tournament placements.</p></section>
      {poolResults.length > 0 && <section className="event-pool-results"><h2>Confirmed pool standings</h2><p className="event-live-note">Places are within each pool, as confirmed by the organisers.</p><div className="event-results-grid">{poolResults.map(pool => <article className="event-prize" key={pool.title}><h3>{pool.title}</h3><ol className="event-pool-ranking">{pool.results.map(result => <li key={result.alias}><span>{result.place}</span> {result.alias}</li>)}</ol><ResultGraphic title={`${data.plan.name} · ${pool.title}`} results={pool.results} /></article>)}</div></section>}
      {data.prizes.length > 0 && <section className="event-prizes"><h2>On the line</h2><div className="event-results-grid">{data.prizes.map(prize => <article className="event-prize" key={prize.id}><span className="event-eyebrow">PRIZE</span><h3>{prize.title}</h3><p>{prize.description}</p>{prize.playerName && <strong>{prize.playerName}</strong>}</article>)}</div></section>}
    </>
  </div>;
}
export function MatchCard({ match, station }: { match: LiveMatch; station?: string }) {
  return <article className={`event-match ${match.status === 'playing' ? 'is-playing' : ''}`}>
    <div className="event-match-meta"><span>{match.division} · {match.stage === 'group' ? `Pool ${match.poolIndex === null ? '—' : String.fromCharCode(65 + match.poolIndex)}` : match.stage}</span><span>{station || match.label}</span></div>
    {[{ name: match.player1Name, characters: match.player1Characters, id: match.player1Id, score: match.score1 }, { name: match.player2Name, characters: match.player2Characters, id: match.player2Id, score: match.score2 }].map((p, i) => <div className={`event-contender ${match.status === 'complete' && p.id && p.id === match.winnerId ? 'is-winner' : ''}`} key={i}><span>{p.name || 'To be decided'}<CharacterIcons slugs={p.characters ?? []} /></span><strong>{p.score ?? '—'}</strong></div>)}
    {match.status === 'complete' && <span className="event-match-status">Final</span>}
  </article>;
}
