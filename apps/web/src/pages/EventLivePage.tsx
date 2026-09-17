import { useEffect, type CSSProperties } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import './EventLive.css';
import { ResultGraphic } from '../components/ResultGraphic';
import { confirmedPoolGraphics } from '../lib/resultGraphic';

import { liveSections, overlayGeometry, type LiveMatch } from '../lib/eventDisplay';
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
  const variables = { '--capture-width': `${geometry.width}%`, '--capture-height': `${geometry.height}%` } as CSSProperties;
  const station = (match: LiveMatch) => data.stations.find(s => s.id === match.stationId)?.name;
  return <div className={`event-display ${overlay ? 'event-overlay' : ''}`} style={variables}>
    <header className="event-live-header"><div><span className="event-eyebrow">SMASH CLUB / {sections.playing.length ? 'LIVE NOW' : 'EVENT BOARD'}</span><h1>{data.plan.name}</h1></div>
      <div className="event-live-progress"><strong>{sections.complete.length}<span> / {sections.total}</span></strong><span>sets complete</span><progress value={sections.complete.length} max={Math.max(1, sections.total)} aria-label="Sets completed" /></div>
    </header>
    <div className="event-connection" role="status">{query.isError ? 'Connection interrupted · showing last received results' : 'Updates automatically every 5 seconds'}</div>
    {overlay && <div className="event-capture" aria-label="Transparent game capture area" />}
    <div className="event-live-columns">
      <section className="event-now"><h2><span className="event-live-dot" />Now playing <span>{sections.playing.length}</span></h2>
        {sections.playing.length ? sections.playing.slice(0, overlay ? 3 : undefined).map(match => <MatchCard key={match.id} match={match} station={station(match)} />) : <p className="event-empty">Waiting for the next set. Stay ready.</p>}
      </section>
      <section className="event-next"><h2>Up next <span>{sections.ready.length}</span></h2>
        {sections.ready.length ? sections.ready.slice(0, overlay ? 3 : 8).map(match => <MatchCard key={match.id} match={match} station={station(match)} />) : <p className="event-empty">The next matchups will appear here.</p>}
      </section>
    </div>
    <aside className="event-announcements" aria-label="Announcements">{data.announcements.length ? data.announcements.slice(-2).map(a => <p key={a.id}><strong>CLUB NOTICE</strong> {a.message}</p>) : <p><strong>SMASH CLUB</strong> Good games. Good company.</p>}</aside>
    {!overlay && <>
      <section className="event-recent"><h2>Recorded results</h2>{sections.complete.length ? <div className="event-results-grid">{sections.complete.slice(-12).reverse().map(match => <MatchCard key={match.id} match={match} station={station(match)} />)}</div> : <p className="event-empty">Results appear here once confirmed.</p>}<p className="event-live-note">Set results are shown as recorded. They do not imply final tournament placements.</p></section>
      {poolResults.length > 0 && <section className="event-pool-results"><h2>Confirmed pool standings</h2><p className="event-live-note">Places are within each pool, as confirmed by the organisers.</p><div className="event-results-grid">{poolResults.map(pool => <article className="event-prize" key={pool.title}><h3>{pool.title}</h3><ol className="event-pool-ranking">{pool.results.map(result => <li key={result.alias}><span>{result.place}</span> {result.alias}</li>)}</ol><ResultGraphic title={`${data.plan.name} · ${pool.title}`} results={pool.results} /></article>)}</div></section>}
      {data.prizes.length > 0 && <section className="event-prizes"><h2>On the line</h2><div className="event-results-grid">{data.prizes.map(prize => <article className="event-prize" key={prize.id}><span className="event-eyebrow">PRIZE</span><h3>{prize.title}</h3><p>{prize.description}</p>{prize.playerName && <strong>{prize.playerName}</strong>}</article>)}</div></section>}
    </>}
  </div>;
}
export function MatchCard({ match, station }: { match: LiveMatch; station?: string }) {
  return <article className={`event-match ${match.status === 'playing' ? 'is-playing' : ''}`}>
    <div className="event-match-meta"><span>{match.division} · {match.stage === 'group' ? `Pool ${match.poolIndex === null ? '—' : String.fromCharCode(65 + match.poolIndex)}` : match.stage}</span><span>{station || match.label}</span></div>
    {[{ name: match.player1Name, id: match.player1Id, score: match.score1 }, { name: match.player2Name, id: match.player2Id, score: match.score2 }].map((p, i) => <div className={`event-contender ${match.status === 'complete' && p.id && p.id === match.winnerId ? 'is-winner' : ''}`} key={i}><span>{p.name || 'To be decided'}</span><strong>{p.score ?? '—'}</strong></div>)}
    {match.status === 'complete' && <span className="event-match-status">Final</span>}
  </article>;
}
