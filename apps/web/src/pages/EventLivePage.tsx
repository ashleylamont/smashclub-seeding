import { BroadcastIntermission } from '../components/BroadcastIntermission';
import { BroadcastPresentationControls } from '../components/BroadcastPresentationControls';
import { broadcastPresentation, progressInterval } from '../lib/broadcastProgress';
import { PlayerEventAlias } from './GuestEventPage';
import { Progress } from '../components/ui/Progress';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { eventUnavailable } from '../lib/eventErrors';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import './EventLive.css';
import { NemesisMark } from '../components/NemesisMark';
import { CharacterIcons } from '../components/CharacterIcons';
import { OverlaySetup } from '../components/OverlaySetup';
import { OverlayTwitchLink, OverlayTwitchSetting } from '../components/OverlayTwitch';
import { twitchChannel } from '@smashclub/shared';
import { matchesPool, usePoolFilter } from '../lib/poolFlow';
import { GuestOverlayQr } from '../components/GuestOverlayQr';
import { BroadcastResults } from '../components/BroadcastResults';
import { BroadcastRecentSets } from '../components/BroadcastRecentSets';
import { broadcastPlayers } from '../lib/broadcastPlayers';
import { recentResultCount } from '../lib/broadcastSidebar';
import { useGuestClock } from '../lib/guestReporting';

import { liveSections, overlayGeometry, type LiveMatch } from '../lib/eventDisplay';
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
  const [presentation, setPresentation] = useState(() => broadcastPresentation(location.search));
  const [cycleSeconds, setCycleSeconds] = useState(() => progressInterval(location.search));
  const [twitch, setTwitch] = useState(() =>
    twitchChannel(new URLSearchParams(location.search).get('twitch') ?? ''),
  );
  const [compactRail, setCompactRail] = useState(false);
  const observeRail = useCallback(
    (rail: HTMLElement | null) => {
      if (!rail || compactRail) return;

      // Keep the composition stable once a crowded source needs the compact rail.
      const fit = () => {
        const last = rail.lastElementChild;
        if (!last || !rail.clientHeight) return;
        const { bottom } = rail.getBoundingClientRect();
        const padding = parseFloat(getComputedStyle(rail).paddingBottom);
        if (last.getBoundingClientRect().bottom > bottom - padding + 1) setCompactRail(true);
      };
      const sizes = new ResizeObserver(fit);
      const observeChildren = () => {
        sizes.disconnect();
        sizes.observe(rail, { box: 'border-box' });
        for (const child of rail.children) sizes.observe(child, { box: 'border-box' });
        fit();
      };
      // The guest pass can appear or disappear after the event snapshot loads.
      const children = new MutationObserver(observeChildren);
      children.observe(rail, { childList: true });
      observeChildren();
      return () => {
        children.disconnect();
        sizes.disconnect();
      };
    },
    [compactRail],
  );
  const changePresentation = (mode: typeof presentation, seconds: number) => {
    const url = new URL(location.href);
    url.searchParams.set('presentation', mode);
    url.searchParams.set('cycleSeconds', String(seconds));
    history.replaceState(history.state, '', url);
    setPresentation(mode);
    setCycleSeconds(seconds);
  };
  const changeFocus = (stationId: string) => {
    const url = new URL(window.location.href);
    if (stationId) url.searchParams.set('station', stationId);
    else url.searchParams.delete('station');
    window.history.replaceState(window.history.state, '', url);
    setFocus(stationId);
  };
  const changeTwitch = (channel: string) => {
    const url = new URL(location.href);
    if (channel) url.searchParams.set('twitch', channel);
    else url.searchParams.delete('twitch');
    history.replaceState(history.state, '', url);
    setTwitch(channel);
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
  const data = query.data;
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
  const closedLabel = data.plan.status === 'cancelled' ? 'EVENT CANCELLED' : 'EVENT FINISHED';
  const visibleMatches = data.matches.filter((match) => matchesPool(match, selectedPool));
  const sections = liveSections(visibleMatches, data.plan.liveOwned);
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
  // Keep the current broadcast tied to its selected station between sets.
  const broadcastStation = focus
    ? focusedStation
    : (data.stations.find((item) => item.name.toLowerCase() === 'stage') ?? data.stations[0]);
  const playing = closed ? [] : sections.playing;
  const onStream = broadcastStation
    ? playing.find((match) => match.stationId === broadcastStation.id)
    : focus
      ? undefined
      : playing[0];
  const displayPlayers = broadcastPlayers(data, onStream);
  const [showName, ...editionParts] = data.plan.name.split(' · ');
  const edition = editionParts.join(' · ');
  const intermission = presentation === 'progress' || (presentation === 'auto' && !onStream);
  if (overlay)
    return (
      <div
        className={`event-display event-overlay${intermission ? ' is-intermission' : ''}`}
        style={variables}
      >
        <aside
          ref={observeRail}
          className={`broadcast-rail${guestQr ? ' has-guest-pass' : ''}${compactRail ? ' is-compact' : ''}`}
        >
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
            {edition && <span className="broadcast-edition">{edition}</span>}
          </div>
          <BroadcastRecentSets
            matches={visibleMatches}
            count={recentResultCount(window.location.search)}
          />
          <div className="broadcast-progress">
            <span>{selectedPool ? 'POOL PROGRESS' : 'EVENT PROGRESS'}</span>
            <strong>
              {String(sections.complete.length).padStart(2, '0')}
              <i>/{String(sections.total).padStart(2, '0')}</i>
            </strong>
            <Progress
              value={sections.complete.length}
              max={Math.max(1, sections.total)}
              label="Sets completed"
            />
            <small>SETS COMPLETE</small>
          </div>
          {guestQr && <GuestOverlayQr planId={planId} invitation={guestQr} />}
        </aside>
        <header className={`broadcast-topline${twitch ? ' has-twitch-link' : ''}`}>
          <span>
            <i /> {closed ? closedLabel : onStream ? 'PLAYING NOW' : 'WAITING FOR A MATCH'}
          </span>
          <span>
            {broadcastStation?.name ??
              (onStream ? station(onStream) : null) ??
              (focus ? 'Selected station' : 'Main broadcast')}{' '}
            /{' '}
            {closed
              ? 'NO ACTIVE SET'
              : onStream?.stage === 'group'
                ? 'ROUND ROBIN'
                : (onStream?.stage?.toUpperCase() ?? 'NEXT SET SOON')}
          </span>
          {twitch ? <OverlayTwitchLink channel={twitch} /> : <span>nemesis.ashl.dev</span>}
        </header>
        <div className="broadcast-matchup" aria-label={closed ? undefined : 'Current match'}>
          {!closed && (
            <>
              <div className="broadcast-fighter broadcast-fighter-one">
                <span className="broadcast-side">LEFT</span>
                <strong>{displayPlayers?.left.name || 'AWAITING MATCH'}</strong>
                <CharacterIcons slugs={displayPlayers?.left.characters ?? []} />
                <b>{displayPlayers?.left.score ?? '—'}</b>
              </div>
              <span className="broadcast-match-versus">VS</span>
              <div className="broadcast-fighter broadcast-fighter-two">
                <b>{displayPlayers?.right.score ?? '—'}</b>
                <strong>{displayPlayers?.right.name || 'AWAITING MATCH'}</strong>
                <CharacterIcons slugs={displayPlayers?.right.characters ?? []} />
                <span className="broadcast-side">RIGHT</span>
              </div>
            </>
          )}
        </div>
        <OverlaySetup
          stations={data.stations}
          focus={focusedStation?.id ?? focus}
          onFocus={changeFocus}
          presentationControls={
            <>
              <BroadcastPresentationControls
                mode={presentation}
                seconds={cycleSeconds}
                onMode={(mode) => changePresentation(mode, cycleSeconds)}
                onSeconds={(seconds) => changePresentation(presentation, seconds)}
              />
              <OverlayTwitchSetting channel={twitch} onChange={changeTwitch} />
            </>
          }
        />
        <footer className="broadcast-footer">
          <BroadcastResults
            key={planId}
            matches={data.matches}
            announcement={announcement?.message ?? ''}
          />
        </footer>
        {intermission && (
          <BroadcastIntermission
            data={{
              ...data,
              matches: visibleMatches,
              nativeBrackets: selectedPool ? [] : data.nativeBrackets,
              linkedBrackets: selectedPool ? [] : data.brackets,
              pendingFinals: selectedPool ? [] : data.pendingFinals,
            }}
            seconds={cycleSeconds}
            announcement={announcement?.message ?? ''}
            controls={search.get('controls') !== '0'}
            twitchChannel={twitch}
            preferRecent={presentation === 'auto'}
          />
        )}
        {(!online || query.isError) && (
          <div className="broadcast-offline" role="status">
            Connection interrupted · last received scores
          </div>
        )}
      </div>
    );
  return null;
}
