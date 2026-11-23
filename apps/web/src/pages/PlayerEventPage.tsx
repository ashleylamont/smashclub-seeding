import { useId } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState, Notice } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Progress } from '../components/ui/Progress';
import { useParams } from '@tanstack/react-router';
import { PlayerHubMatches } from '../components/PlayerHubMatches';
import { PlayerHubBoard } from '../components/PlayerHubBoard';
import { EventTwitchPromotion } from '../components/EventTwitchPromotion';
import { PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import {
  usePlayerEventHub,
  type PlayerEventHub,
  type PublicEventSnapshot,
} from '../lib/usePlayerEventHub';
import { guestTimeLeft, type GuestSession } from '../lib/guestReporting';
import { Disclosure } from '../components/ui/Disclosure';
import { matchesPool } from '../lib/poolFlow';
import { formatDate } from '../lib/format';
import '../styles/event.css';
import './EventLive.css';
import './PlayerEvent.css';

export function PlayerEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <PlayerEvent key={planId} planId={planId} />;
}
export function PlayerEvent({ planId }: { planId: string }) {
  const hub = usePlayerEventHub(planId);
  if (hub.unpublished)
    return <Notice tone="danger">This event is unavailable or has not been published.</Notice>;
  const { data } = hub;
  if (
    data?.plan.status === 'complete' &&
    !data.matches.length &&
    (data.plan.bracketMode === 'challonge' || data.plan.historicalResultsSlug)
  )
    return <ImportedArchive data={data} hub={hub} />;
  return <PlayerEventHubPage hub={hub} />;
}

function PlayerEventHubPage({ hub }: { hub: PlayerEventHub }) {
  const {
    publicEvent,
    claim,
    data,
    now,
    reporter,
    closed,
    session,
    signedCredential,
    setReportingPreference,
    valid,
    matches,
    online,
    selectedPool,
    player,
    journey,
    usingLinkedDefault,
    error,
    board,
  } = hub;
  const empty = data?.matches.length === 0;
  const reportingVisible = !empty && !closed;
  const hasRecordedResults =
    data?.matches.some((match) => match.status === 'complete') ||
    Boolean(data?.placements.length || data?.plan.resultsSlug || data?.plan.historicalResultsSlug);
  const updatesInterrupted = !online || publicEvent.isError;
  const labels = closed
    ? { account: 'View signed-in reports', guest: 'View guest reports' }
    : { account: 'Use signed-in reporting', guest: 'Use venue guest pass' };
  const nextLabel = playerNextSectionLabel(closed, data);
  const reportingStatus = (
    <MatchReportingStatus hub={hub} hasRecordedResults={hasRecordedResults} />
  );
  const description = empty
    ? 'Event information and results.'
    : usingLinkedDefault
      ? undefined
      : 'Choose your name to find your matches.';
  return (
    <div className="ops-page player-event-hub">
      <div className="player-event-intro">
        <PageHeader title={publicEvent.data?.plan.name ?? 'Your event'} description={description} />
        {data && !empty && <EventProgress data={data} selectedPool={selectedPool} />}
        <PlayerEventNavigation board={board} nextLabel={nextLabel} />
        <EventTwitchPromotion
          data={data}
          closed={closed}
          interrupted={updatesInterrupted}
          now={now}
        />
        {empty && (
          <EmptyEventMatches
            closed={closed}
            historical={Boolean(data?.plan.historicalResultsSlug)}
          />
        )}
        {claim && !empty && (
          <p>
            Your linked profile: <strong>{claim.playerName}</strong>.
          </p>
        )}
        <EventAnnouncements data={data} now={now} />
        {reporter && reportingVisible && (
          <p className="muted">
            {reporter === 'guest'
              ? 'Reporting with your venue guest pass.'
              : 'Reporting with your signed-in account.'}
          </p>
        )}
        {session && signedCredential && !empty && (valid || reporter === 'guest') && (
          <p>
            <Button
              size="small"
              onClick={() => setReportingPreference(reporter === 'guest' ? 'signed-in' : 'guest')}
            >
              {labels[reporter === 'guest' ? 'account' : 'guest']}
            </Button>
          </p>
        )}
        {(!data || (closed && empty)) && reportingStatus}
        {data && (!closed || hasRecordedResults || updatesInterrupted) && (
          <p
            className="event-connection player-event-connection"
            role={updatesInterrupted ? 'alert' : 'status'}
          >
            {updatesInterrupted
              ? 'Live updates interrupted. Scores shown may be out of date.'
              : closed
                ? 'Recorded tournament results'
                : 'Live event · results refresh automatically'}
          </p>
        )}
        {!data && (
          <GuestLoadState
            pending={publicEvent.isPending}
            onRetry={() => void publicEvent.refetch()}
          />
        )}
      </div>
      {data && (
        <>
          {!empty && (
            <>
              <PlayerHubMatches hub={hub} data={data} reportingStatus={reportingStatus} />
              {nextLabel && (
                <section id="what-next" aria-label={nextLabel}>
                  <PlayerNextSteps hub={hub} data={data} />
                </section>
              )}
            </>
          )}
          <PlayerHubBoard
            data={data}
            selectedPool={selectedPool}
            player={player}
            journeyState={journey?.state}
          />
        </>
      )}
      {error && !matches.isError && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ImportedArchive({ data, hub }: { data: PublicEventSnapshot; hub: PlayerEventHub }) {
  return (
    <div className="ops-page player-event-hub player-event-archive">
      <PageHeader
        title={data.plan.name}
        description={`Finished · ${formatDate(data.plan.eventDate)}`}
      />
      {(!hub.online || hub.publicEvent.isError) && (
        <Notice tone="warning">
          Could not refresh this archive. Showing the last available record.
        </Notice>
      )}
      <PlayerHubBoard data={data} selectedPool="" player="" archiveOnly />
      <EventAnnouncements data={data} now={hub.now} />
    </div>
  );
}

function EventAnnouncements({ data, now }: { data?: PublicEventSnapshot; now: number }) {
  const announcements = data?.announcements
    .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
    .slice(0, 2);
  if (!announcements?.length) return null;
  return (
    <aside className="card event-announcements" aria-label="Announcements">
      <strong>Announcements</strong>
      <div>
        {announcements.map((item) => (
          <p key={item.id}>{item.message}</p>
        ))}
      </div>
    </aside>
  );
}

function EventProgress({
  data,
  selectedPool,
}: {
  data: PublicEventSnapshot;
  selectedPool: string;
}) {
  const noteId = useId();
  const matches = data.matches.filter((match) => matchesPool(match, selectedPool));
  const complete = matches.filter((match) => match.status === 'complete').length;
  const finals = eventFinalsProgress(data);
  const poolProgress = Boolean(selectedPool) || finals === 'pending';
  const title = poolProgress ? 'Pool progress' : 'Event progress';
  const note =
    finals === 'pending'
      ? 'The finals draw is pending.'
      : finals === 'partial'
        ? 'The remaining finals draws are pending.'
        : null;
  return (
    <aside className="player-event-overview" aria-label={title}>
      <span>
        {title} · {complete} / {matches.length} sets complete
        {note && (
          <span className="player-event-progress-note" id={noteId}>
            {note}
          </span>
        )}
      </span>
      <Progress
        label={poolProgress ? 'Pool sets completed' : 'Sets completed'}
        aria-describedby={note ? noteId : undefined}
        value={complete}
        max={Math.max(1, matches.length)}
      />
    </aside>
  );
}

function eventFinalsProgress(data: PublicEventSnapshot) {
  const { plan, matches, nativeBrackets, brackets, pendingFinals } = data;
  const poolThenFinals =
    plan.structure === 'dual_division' ||
    plan.structure === 'pools_finals' ||
    plan.structure === 'round_robin_finals';
  if (
    !poolThenFinals ||
    plan.bracketMode !== 'native' ||
    !['pools_ready', 'underway'].includes(plan.status) ||
    plan.historicalResultsSlug ||
    brackets.some((bracket) => bracket.slug)
  )
    return;

  // Published brackets can be empty. Finals match records also establish that a draw exists.
  const hasDraw =
    nativeBrackets.length > 0 ||
    matches.some((match) => match.stage === 'main' || match.stage === 'consolation');
  if (hasDraw) return pendingFinals?.length ? 'partial' : undefined;

  const pools = matches.filter((match) => match.stage === 'group');
  if (pools.length && pools.every((match) => match.status === 'complete')) return 'pending';
}

function playerNextSectionLabel(closed: boolean, data?: PublicEventSnapshot) {
  if (!closed) return 'What next';
  if (data?.matches.length && data.poolRounds?.some(({ rounds }) => rounds.length > 0))
    return 'Pool schedule';
}

function PlayerEventNavigation({
  board,
  nextLabel,
}: {
  board: PlayerEventHub['board'];
  nextLabel?: string;
}) {
  return (
    <nav className="player-event-nav" aria-label="Event sections">
      <Button asChild>
        <a href="#my-matches">Find my matches</a>
      </Button>
      {nextLabel && (
        <Button asChild>
          <a href="#what-next">{nextLabel}</a>
        </Button>
      )}
      {(board?.sections ?? ['pools', 'brackets', 'results']).map((section) => (
        <Button key={section} asChild>
          <a href={`#event-${section}`}>
            {{ pools: 'Pools', brackets: 'Brackets', results: 'Results' }[section]}
          </a>
        </Button>
      ))}
    </nav>
  );
}

function PlayerNextSteps({ hub, data }: { hub: PlayerEventHub; data: PublicEventSnapshot }) {
  const rounds = (
    <PoolRoundSchedule
      data={data}
      selectedPool={hub.selectedPool}
      playerId={hub.player}
      recordedOnly={hub.closed}
      meetingsPerPairing={
        data.plan.liveOwned ? data.plan.structureOptions?.roundRobinMeetings : undefined
      }
    />
  );
  if (hub.closed) return <Disclosure title="Pool schedule history">{rounds}</Disclosure>;
  const queues = (
    <PoolStationQueue
      data={data}
      selectedPool={hub.selectedPool}
      stationId={hub.stationId}
      playerId={hub.player}
      onStart={(input) => void hub.start(input)}
      onReport={hub.chooseMatch}
      pendingMatchId={hub.starting}
      disabled={!hub.canWrite}
    />
  );
  const poolMatches = hub.playerMatches.filter((match) => match.stage === 'group');
  const finishedPoolMatches =
    poolMatches.length > 0 && poolMatches.every((match) => match.status === 'complete');
  return (
    <>
      {queues}
      {hub.player && finishedPoolMatches ? (
        <Disclosure title="Your pool schedule history">{rounds}</Disclosure>
      ) : (
        rounds
      )}
    </>
  );
}

function EmptyEventMatches({ closed, historical }: { closed: boolean; historical: boolean }) {
  return (
    <>
      <section id="my-matches" className="card" aria-label="Event schedule">
        <h2>Matches & results</h2>
        <p>
          {closed ? 'No matches are recorded for this event.' : 'No matches in this view yet.'}{' '}
          {historical
            ? 'Open Results below for the imported event standings.'
            : !closed && 'The organisers will publish pairings here when they are ready.'}
        </p>
      </section>
      <section id="what-next" aria-label="What next">
        <h2>What next</h2>
        <p>
          {historical
            ? 'This event uses imported results. Match reporting is closed.'
            : closed
              ? 'Check the event announcements or ask an organiser for details.'
              : 'Check event announcements or ask an organiser about the next update.'}
        </p>
      </section>
    </>
  );
}

function MatchReportingStatus({
  hub,
  hasRecordedResults,
}: {
  hub: PlayerEventHub;
  hasRecordedResults: boolean;
}) {
  const {
    accessDenied,
    closed,
    data,
    guestCredential,
    matches,
    now,
    online,
    player,
    playOpen,
    publicEvent,
    redeeming,
    reporter,
    session,
    signedIn,
    valid,
  } = hub;
  if (closed)
    return player ? null : (
      <Notice>
        {hasRecordedResults
          ? 'This event is closed. Results remain available. Ask a TO about corrections.'
          : 'This event is closed. Score reporting is unavailable.'}
      </Notice>
    );

  return (
    <>
      {data && signedIn && !data.settings.playerReports && !guestCredential && (
        <Notice tone="warning">
          Signed-in reporting is off for this event. A TO can record your score.
        </Notice>
      )}
      {data && !playOpen && (
        <Notice tone="warning">
          {data.plan.drawPaused
            ? 'The draw is paused. Reporting reopens when play resumes.'
            : 'Match reporting opens when the organiser locks the pool draw.'}
        </Notice>
      )}
      {(reporter !== 'signed-in' || redeeming) && (
        <GuestPassStatus
          redeeming={redeeming}
          valid={valid}
          session={session}
          now={now}
          error={matches.isError ? matches.error.message : null}
          accessDenied={accessDenied}
        />
      )}
      {playOpen &&
        reporter &&
        (!online || publicEvent.isError) &&
        !(reporter === 'guest' && matches.isError) && (
          <Notice tone="warning">
            Score reporting will resume when live updates recover. Your draft is kept.
          </Notice>
        )}
    </>
  );
}

function GuestPassStatus({
  redeeming,
  valid,
  session,
  now,
  error,
  accessDenied,
}: {
  redeeming: boolean;
  valid: boolean;
  session: GuestSession | null;
  now: number;
  error: string | null;
  accessDenied: boolean;
}) {
  if (redeeming) return <LoadingState>Opening your guest pass…</LoadingState>;
  const passInstructions =
    'To start a match or report a score, scan a guest reporting QR or ask a TO for a pass.';
  if (!session && !error && !accessDenied) return <p className="muted">{passInstructions}</p>;
  if (!valid || accessDenied)
    return (
      <section className="card">
        <h2>{session && !valid ? 'Your guest pass has expired' : 'Refresh your guest pass'}</h2>
        <p>{passInstructions} You can browse without a pass.</p>
        {error && (
          <p className="banner banner-warning" role="alert">
            {error} If this pass was revoked, ask a TO for a new QR.
          </p>
        )}
      </section>
    );
  return (
    <>
      <p className="guest-pass-expiry">
        {session!.expiresAt
          ? `Guest pass · ${guestTimeLeft(session!.expiresAt, now)} remaining`
          : 'Guest pass · valid until revoked'}
      </p>
      {error && (
        <Notice tone="warning">
          Reporting connection interrupted. Your pass and score draft are kept. Reporting resumes
          when the connection recovers.
        </Notice>
      )}
    </>
  );
}

function GuestLoadState({ pending, onRetry }: { pending: boolean; onRetry: () => void }) {
  if (pending) return <LoadingState>Loading your event…</LoadingState>;
  return (
    <Notice tone="danger">
      Could not load matches.
      <Button size="small" onClick={onRetry}>
        Retry
      </Button>
    </Notice>
  );
}
