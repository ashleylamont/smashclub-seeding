import { useEffect, type CSSProperties } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import './EventLive.css';
import { ResultGraphic } from '../components/ResultGraphic';
import { GuestOverlayQr } from '../components/GuestOverlayQr';
import { BroadcastResults } from '../components/BroadcastResults';
import { recentResults } from '../lib/broadcastResults';
import { useGuestClock } from '../lib/guestReporting';
import { confirmedPoolGraphics } from '../lib/resultGraphic';

import { broadcastQueue, liveSections, overlayGeometry, type LiveMatch } from '../lib/eventDisplay';
export function EventLivePage() {
  const { planId } = useParams({ from: '/live/$planId' });
  return <EventDisplay planId={planId} />;
}
export function EventOverlayPage() {
  const { planId } = useParams({ from: '/overlay/$planId' });
  return <EventDisplay planId={planId} overlay />;
}
function EventDisplay({ planId, overlay = false }: { planId: string; overlay?: boolean }) {
  const query = useQuery({ queryKey: ['eventOps', 'snapshot', planId], queryFn: () => trpc.eventOps.snapshot.query({ planId }),
    refetchInterval: 5000, refetchIntervalInBackground: true, retry: 1 });
  const now = useGuestClock();
  const guestInvitation = useQuery({ queryKey: ['overlayGuestInvitation', planId], queryFn: () => trpc.eventOps.guests.overlayInvitation.query({ planId }), enabled: overlay, refetchInterval: 10000, refetchIntervalInBackground: true, retry: false });
  const guestQr = !guestInvitation.isError && guestInvitation.data && Date.parse(guestInvitation.data.expiresAt) > now ? guestInvitation.data : null;
  useEffect(() => {
    if (!overlay) return;
    document.documentElement.classList.add('event-overlay-document');
    return () => document.documentElement.classList.remove('event-overlay-document');
  }, [overlay]);
  const publicationUnavailable = query.error instanceof TRPCClientError && ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(query.error.data?.code ?? '');
  if (!query.data || publicationUnavailable) return <div className={overlay ? 'event-display-message' : 'loading-text'} role="status">{query.isError ? 'This event is unavailable or has not been published.' : 'Loading live event…'}</div>;
  const data = query.data;
  const sections = liveSections(data.matches);
  const poolResults = confirmedPoolGraphics(data.placements, data.entrants);
  const geometry = overlayGeometry(window.location.search);
  const search = new URLSearchParams(window.location.search);
  const customGeometry = search.has('captureWidth') || search.has('captureHeight');
  const variables = (customGeometry ? { '--capture-width': `${geometry.width}vw`, '--capture-height': `${geometry.height}vh` } : {}) as CSSProperties;
  const station = (match: LiveMatch) => data.stations.find(s => s.id === match.stationId)?.name;
  const focus = search.get('station');
  const focusedStation = focus ? data.stations.find(item => item.id === focus || item.name.toLowerCase() === focus.toLowerCase()) : undefined;
  const onStream = focus ? sections.playing.find(match => match.stationId === focusedStation?.id) :
    sections.playing.find(match => station(match)?.toLowerCase() === 'stage') ?? sections.playing[0];
  const onDeck = broadcastQueue(sections.ready.filter(match => !focus || !match.stationId || match.stationId === focusedStation?.id));
  const showName = data.plan.name.split(' · ')[0]!;
  if (overlay) return <div className="event-display event-overlay" style={variables}>
    <aside className={`broadcast-rail${guestQr ? ' has-guest-pass' : ''}`}>
      <div className="broadcast-club"><BroadcastMark /><span>SMASH<br />CLUB</span></div>
      <div className="broadcast-identity"><span className="event-eyebrow">THE CLUB NIGHT</span><h1 title={data.plan.name}>{showName}</h1><span className="broadcast-edition">{data.plan.name.includes(' · ') ? data.plan.name.split(' · ').slice(1).join(' · ') : 'Find your rival.'}</span></div>
      <div className="broadcast-rail-rule"><span>ON DECK</span><span>↗</span></div>
      <div className="broadcast-deck">{onDeck.length ? onDeck.slice(0, guestQr ? 2 : 3).map((match, index) => <article key={match.id}><span className="broadcast-queue-index">0{index + 1}</span><div><small>{match.division} / {match.stage === 'group' ? `POOL ${String.fromCharCode(65 + (match.poolIndex ?? 0))}` : match.stage}</small><strong>{match.player1Name || 'TBD'}</strong><span className="broadcast-versus">vs</span><strong>{match.player2Name || 'TBD'}</strong></div></article>) : <p className="broadcast-wait">Next challengers<br />coming up.</p>}</div>
      <div className="broadcast-progress"><span>THE NIGHT SO FAR</span><strong>{String(sections.complete.length).padStart(2, '0')}<i>/{String(sections.total).padStart(2, '0')}</i></strong><progress value={sections.complete.length} max={Math.max(1, sections.total)} aria-label="Sets completed" /><small>SETS IN THE BOOKS</small></div>
      {guestQr && <GuestOverlayQr planId={planId} invitation={guestQr} />}
      <span className="broadcast-rail-footer">GOOD GAMES. GREAT RIVALS.</span>
    </aside>
    <header className="broadcast-topline"><span><i /> {onStream ? 'ON AIR' : 'STAND BY'}</span><span>{focusedStation?.name ?? (onStream ? station(onStream) : null) ?? (focus ? 'Selected station' : 'Main broadcast')} / {onStream?.stage === 'group' ? 'ROUND ROBIN' : onStream?.stage?.toUpperCase() ?? 'NEXT SET SOON'}</span><span>nemesis.ashl.dev</span></header>
    <div className="broadcast-matchup" aria-label="On-stream matchup">
      <div className="broadcast-fighter broadcast-fighter-one"><span className="broadcast-side">P1</span><strong>{onStream?.player1Name || 'NEXT CHALLENGER'}</strong><b>{onStream?.score1 ?? '—'}</b></div>
      <span className="broadcast-match-versus">VS</span>
      <div className="broadcast-fighter broadcast-fighter-two"><b>{onStream?.score2 ?? '—'}</b><strong>{onStream?.player2Name || 'NEXT CHALLENGER'}</strong><span className="broadcast-side">P2</span></div>
    </div>
    <div className="event-capture" aria-label="Transparent game capture area"><span className="capture-corner capture-corner-tl" /><span className="capture-corner capture-corner-br" /></div>
    <footer className="broadcast-footer"><BroadcastResults key={planId} matches={data.matches} announcement={data.announcements[0]?.message ?? 'Grab a setup. Find your rival. Make it a good set.'} /></footer>
    {query.isError && <div className="broadcast-offline" role="status">Connection interrupted · last received scores</div>}
  </div>;
  return <div className="event-display event-board" style={variables}>
    <header className="event-live-header"><div className="event-board-brand"><BroadcastMark /><span>SMASH CLUB<br />TOURNAMENT NIGHT</span></div><div className="event-board-title"><span className="event-eyebrow">FIND YOUR RIVAL.</span><h1>{data.plan.name}</h1></div>
      <div className="event-live-progress"><span>THE NIGHT SO FAR</span><strong>{String(sections.complete.length).padStart(2, '0')}<span> / {sections.total}</span></strong><span>sets in the books</span><progress value={sections.complete.length} max={Math.max(1, sections.total)} aria-label="Sets completed" /></div>
    </header>
    <div className="event-connection" role="status"><span><i className="event-live-dot" />{sections.playing.length ? 'LIVE FROM THE CLUB' : 'THE EVENT BOARD'}</span><span>{query.isError ? 'Connection interrupted · showing last received results' : 'Results refresh every 5 seconds'}</span></div>
    <div className="event-live-columns">
      <section className="event-now"><h2><span>01 /</span> On the setups <span>{sections.playing.length} LIVE</span></h2>
        {sections.playing.length ? sections.playing.map(match => <MatchCard key={match.id} match={match} station={station(match)} />) : <p className="event-empty">A little breather.<br /><strong>The next set is coming.</strong></p>}
      </section>
      <section className="event-next"><h2><span>02 /</span> On deck <span>{sections.ready.length} READY</span></h2>
        {sections.ready.length ? sections.ready.slice(0, 6).map(match => <MatchCard key={match.id} match={match} station={station(match)} />) : <p className="event-empty">Stay close. Your next matchup lands here.</p>}
      </section>
    </div>
    <aside className="event-announcements" aria-label="Announcements"><strong>FROM THE FLOOR ↗</strong><div>{data.announcements.length ? data.announcements.slice(0, 2).map(a => <p key={a.id}>{a.message}</p>) : <p>Good games. Great rivals. Welcome to the club.</p>}</div></aside>
    <>
      {data.settings.playerReports && <p><a className="btn" href={`/play/${planId}`}>Report your match score →</a></p>}
      <section className="event-recent"><h2>Recorded results</h2>{sections.complete.length ? <div className="event-results-grid">{recentResults(data.matches, 12).map(match => <MatchCard key={match.id} match={match} station={station(match)} />)}</div> : <p className="event-empty">Results appear here once confirmed.</p>}<p className="event-live-note">Set results are shown as recorded. They do not imply final tournament placements.</p></section>
      {poolResults.length > 0 && <section className="event-pool-results"><h2>Confirmed pool standings</h2><p className="event-live-note">Places are within each pool, as confirmed by the organisers.</p><div className="event-results-grid">{poolResults.map(pool => <article className="event-prize" key={pool.title}><h3>{pool.title}</h3><ol className="event-pool-ranking">{pool.results.map(result => <li key={result.alias}><span>{result.place}</span> {result.alias}</li>)}</ol><ResultGraphic title={`${data.plan.name} · ${pool.title}`} results={pool.results} /></article>)}</div></section>}
      {data.prizes.length > 0 && <section className="event-prizes"><h2>On the line</h2><div className="event-results-grid">{data.prizes.map(prize => <article className="event-prize" key={prize.id}><span className="event-eyebrow">PRIZE</span><h3>{prize.title}</h3><p>{prize.description}</p>{prize.playerName && <strong>{prize.playerName}</strong>}</article>)}</div></section>}
    </>
  </div>;
}
export function MatchCard({ match, station }: { match: LiveMatch; station?: string }) {
  return <article className={`event-match ${match.status === 'playing' ? 'is-playing' : ''}`}>
    <div className="event-match-meta"><span>{match.division} · {match.stage === 'group' ? `Pool ${match.poolIndex === null ? '—' : String.fromCharCode(65 + match.poolIndex)}` : match.stage}</span><span>{station || match.label}</span></div>
    {[{ name: match.player1Name, id: match.player1Id, score: match.score1 }, { name: match.player2Name, id: match.player2Id, score: match.score2 }].map((p, i) => <div className={`event-contender ${match.status === 'complete' && p.id && p.id === match.winnerId ? 'is-winner' : ''}`} key={i}><span>{p.name || 'To be decided'}</span><strong>{p.score ?? '—'}</strong></div>)}
    {match.status === 'complete' && <span className="event-match-status">Final</span>}
  </article>;
}

function BroadcastMark() {
  return <svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><path d="M8 92V8h20l44 54V8h20v84H72L28 38v54Z" /><path d="M36 8h17l39 48V35L70 8H36Z" opacity=".45" /></svg>;
}
