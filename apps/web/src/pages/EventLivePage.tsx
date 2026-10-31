import { PlayerEventAlias } from './GuestEventPage';
import { useEffect, useState, type CSSProperties } from 'react';
import { eventUnavailable } from '../lib/eventErrors';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import './EventLive.css';
import { NemesisMark } from '../components/NemesisMark';
import { CharacterIcons } from '../components/CharacterIcons';
import { OverlaySetup } from '../components/OverlaySetup';
import { matchesPool, stationPreview, usePoolFilter, type PoolFlowData } from '../lib/poolFlow';
import { GuestOverlayQr } from '../components/GuestOverlayQr';
import { BroadcastResults } from '../components/BroadcastResults';
import { useGuestClock } from '../lib/guestReporting';

import { broadcastQueue, liveSections, overlayGeometry, type LiveMatch } from '../lib/eventDisplay';
export function EventLivePage() {
  return <PlayerEventAlias />;
}
export function EventOverlayPage() {
  const { planId } = useParams({ from: '/overlay/$planId' });
  return <EventDisplay key={planId} planId={planId} overlay />;
}
function EventDisplay({ planId, overlay = false }: { planId: string; overlay?: boolean }) {
  const online = useOnlineStatus();
  const query = useQuery({
    queryKey: ['eventOps', 'snapshot', planId],
    queryFn: () => trpc.eventOps.snapshot.query({ planId }),
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    retry: 1,
  });
  const now = useGuestClock();
  const [selectedPool] = usePoolFilter();
  const [focus, setFocus] = useState(
    () => new URLSearchParams(window.location.search).get('station') ?? '',
  );
  const changeFocus = (stationId: string) => {
    const url = new URL(window.location.href);
    if (stationId) url.searchParams.set('station', stationId);
    else url.searchParams.delete('station');
    window.history.replaceState(window.history.state, '', url);
    setFocus(stationId);
  };
  const guestInvitation = useQuery({
    queryKey: ['overlayGuestInvitation', planId],
    queryFn: () => trpc.eventOps.guests.overlayInvitation.query({ planId }),
    enabled: overlay,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const guestQr =
    !guestInvitation.isError &&
    guestInvitation.data &&
    (!guestInvitation.data.expiresAt || Date.parse(guestInvitation.data.expiresAt) > now)
      ? guestInvitation.data
      : null;
  useEffect(() => {
    if (!overlay) return;
    document.documentElement.classList.add('event-overlay-document');
    return () => document.documentElement.classList.remove('event-overlay-document');
  }, [overlay]);
  const publicationUnavailable = eventUnavailable(query.error);
  if (!query.data || publicationUnavailable)
    return (
      <div className={overlay ? 'event-display-message' : 'loading-text'} role="status">
        {query.isError
          ? 'This event is unavailable or has not been published.'
          : 'Loading live event…'}
      </div>
    );
  const data: typeof query.data & Partial<Pick<PoolFlowData, 'stationQueues' | 'poolRounds'>> =
    query.data;
  const announcement = data.announcements.find(
    (item) => !('expiresAt' in item) || !item.expiresAt || Date.parse(String(item.expiresAt)) > now,
  );
  if (data.plan.historicalResultsSlug)
    return (
      <section className={overlay ? 'event-display-message' : 'card section'}>
        <h1>{data.plan.name}</h1>
        <p>Historical event — results come from the imported brackets.</p>
        <a href={`/events/${encodeURIComponent(data.plan.historicalResultsSlug)}`}>
          View historical results →
        </a>
      </section>
    );
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const visibleMatches = data.matches.filter((match) => matchesPool(match, selectedPool));
  const sections = liveSections(visibleMatches);
  const geometry = overlayGeometry(window.location.search);
  const search = new URLSearchParams(window.location.search);
  const customGeometry = search.has('captureWidth') || search.has('captureHeight');
  const variables = (
    customGeometry
      ? { '--capture-width': `${geometry.width}vw`, '--capture-height': `${geometry.height}vh` }
      : {}
  ) as CSSProperties;
  const station = (match: LiveMatch) => data.stations.find((s) => s.id === match.stationId)?.name;
  const focusedStation = focus
    ? data.stations.find(
        (item) => item.id === focus || item.name.toLowerCase() === focus.toLowerCase(),
      )
    : undefined;
  // Keep the broadcast tied to its station between sets, so the next pairing
  // comes from the same authoritative queue attendees use to start a match.
  const broadcastStation = focus
    ? focusedStation
    : (data.stations.find((item) => item.name.toLowerCase() === 'stage') ?? data.stations[0]);
  const onStream = broadcastStation
    ? sections.playing.find((match) => match.stationId === broadcastStation.id)
    : focus
      ? undefined
      : sections.playing[0];
  const stationQueue = data.stationQueues?.find(
    (queue) => queue.stationId === (broadcastStation?.id ?? onStream?.stationId),
  );
  const onDeck = stationQueue
    ? stationPreview(stationQueue, data.matches).filter((match) => matchesPool(match, selectedPool))
    : focus
      ? []
      : broadcastQueue(sections.ready);
  const provisionalNext =
    stationQueue !== undefined &&
    (!stationQueue.nextMatchId || Boolean(stationQueue.currentMatchId));
  const otherPlaying = sections.playing.filter((match) => match.id !== onStream?.id);
  const showName = data.plan.name.split(' · ')[0]!;
  if (overlay)
    return (
      <div className="event-display event-overlay" style={variables}>
        <aside className={`broadcast-rail${guestQr ? ' has-guest-pass' : ''}`}>
          <div className="broadcast-club">
            <NemesisMark />
            <span>
              SMASH
              <br />
              CLUB
            </span>
          </div>
          <div className="broadcast-identity">
            <h1 title={data.plan.name}>{showName}</h1>
            {data.plan.name.includes(' · ') && (
              <span className="broadcast-edition">
                {data.plan.name.split(' · ').slice(1).join(' · ')}
              </span>
            )}
          </div>
          <div className="broadcast-rail-rule">
            <span>{provisionalNext ? 'COMING UP' : 'PLAY NEXT'}</span>
            <span>↗</span>
          </div>
          <div className="broadcast-deck">
            {onDeck.length ? (
              onDeck.slice(0, otherPlaying.length ? 1 : guestQr ? 2 : 3).map((match, index) => (
                <article key={match.id}>
                  <span className="broadcast-queue-index">0{index + 1}</span>
                  <div>
                    <small>
                      {match.division} /{' '}
                      {match.stage === 'group'
                        ? `POOL ${String.fromCharCode(65 + (match.poolIndex ?? 0))}`
                        : match.stage}
                      {stationQueue
                        ? match.id === stationQueue.nextMatchId
                          ? ' / PLAY NEXT'
                          : ' / COMING UP · provisional'
                        : ''}
                    </small>
                    <strong>{match.player1Name || 'TBD'}</strong>
                    <span className="broadcast-versus">vs</span>
                    <strong>{match.player2Name || 'TBD'}</strong>
                  </div>
                </article>
              ))
            ) : (
              <p className="broadcast-wait">
                Next challengers
                <br />
                coming up.
              </p>
            )}
          </div>
          {otherPlaying.length > 0 && (
            <div className="broadcast-other-stations" aria-label="Other stations playing">
              <span>OTHER STATIONS / PLAYING NOW</span>
              {otherPlaying.slice(0, guestQr ? 1 : 2).map((match) => (
                <article key={match.id}>
                  <small>{station(match) ?? 'Unassigned setup'}</small>
                  <strong>
                    {match.player1Name}{' '}
                    <b>
                      {match.score1 ?? '–'}:{match.score2 ?? '–'}
                    </b>{' '}
                    {match.player2Name}
                  </strong>
                </article>
              ))}
              {otherPlaying.length > (guestQr ? 1 : 2) && (
                <small>+ {otherPlaying.length - (guestQr ? 1 : 2)} more playing</small>
              )}
            </div>
          )}
          <div className="broadcast-progress">
            <span>{selectedPool ? 'POOL PROGRESS' : 'EVENT PROGRESS'}</span>
            <strong>
              {String(sections.complete.length).padStart(2, '0')}
              <i>/{String(sections.total).padStart(2, '0')}</i>
            </strong>
            <progress
              value={sections.complete.length}
              max={Math.max(1, sections.total)}
              aria-label="Sets completed"
            />
            <small>SETS COMPLETE</small>
          </div>
          {guestQr && <GuestOverlayQr planId={planId} invitation={guestQr} />}
        </aside>
        <header className="broadcast-topline">
          <span>
            <i /> {closed ? 'EVENT FINISHED' : onStream ? 'PLAYING NOW' : 'WAITING FOR A MATCH'}
          </span>
          <span>
            {broadcastStation?.name ??
              (onStream ? station(onStream) : null) ??
              (focus ? 'Selected station' : 'Main broadcast')}{' '}
            /{' '}
            {onStream?.stage === 'group'
              ? 'ROUND ROBIN'
              : (onStream?.stage?.toUpperCase() ?? 'NEXT SET SOON')}
          </span>
          <span>nemesis.ashl.dev</span>
        </header>
        <div className="broadcast-matchup" aria-label="Current match">
          <div className="broadcast-fighter broadcast-fighter-one">
            <span className="broadcast-side">P1</span>
            <strong>
              {onStream?.player1Name || (closed ? 'EVENT FINISHED' : 'AWAITING MATCH')}
            </strong>
            <CharacterIcons slugs={onStream?.player1Characters ?? []} />
            <b>{onStream?.score1 ?? '—'}</b>
          </div>
          <span className="broadcast-match-versus">VS</span>
          <div className="broadcast-fighter broadcast-fighter-two">
            <b>{onStream?.score2 ?? '—'}</b>
            <strong>
              {onStream?.player2Name || (closed ? 'EVENT FINISHED' : 'AWAITING MATCH')}
            </strong>
            <CharacterIcons slugs={onStream?.player2Characters ?? []} />
            <span className="broadcast-side">P2</span>
          </div>
        </div>
        <OverlaySetup
          stations={data.stations}
          focus={focusedStation?.id ?? focus}
          onFocus={changeFocus}
        />
        <footer className="broadcast-footer">
          <BroadcastResults
            key={planId}
            matches={data.matches}
            announcement={announcement?.message ?? ''}
          />
        </footer>
        {(!online || query.isError) && (
          <div className="broadcast-offline" role="status">
            Connection interrupted · last received scores
          </div>
        )}
      </div>
    );
  return null;
}
