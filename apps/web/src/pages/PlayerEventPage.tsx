import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState, Notice } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { useParams } from '@tanstack/react-router';
import { PlayerHubMatches } from '../components/PlayerHubMatches';
import { PlayerHubBoard } from '../components/PlayerHubBoard';
import { PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import {
  usePlayerEventHub,
  type PlayerEventHub,
  type PublicEventSnapshot,
} from '../lib/usePlayerEventHub';
import { guestTimeLeft, type GuestSession } from '../lib/guestReporting';
import { Disclosure } from '../components/ui/Disclosure';
import { matchesPool } from '../lib/poolFlow';
import '../styles/event.css';
import './EventLive.css';
import './PlayerEvent.css';

export function PlayerEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <PlayerEvent key={planId} planId={planId} />;
}
export function PlayerEvent({ planId }: { planId: string }) {
  const hub = usePlayerEventHub(planId);
  const {
    unpublished,
    publicEvent,
    claim,
    data,
    now,
    reporter,
    closed,
    session,
    signedCredential,
    setReportingPreference,
    playOpen,
    redeeming,
    valid,
    matches,
    accessDenied,
    online,
    signedIn,
    guestCredential,
    selectedPool,
    player,
    error,
    board,
  } = hub;
  const empty = data?.matches.length === 0;
  const reportingVisible = !empty && !closed;
  const announcements =
    data?.announcements
      .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
      .slice(0, 2) ?? [];
  const progressMatches = data?.matches.filter((match) => matchesPool(match, selectedPool)) ?? [];
  const progressComplete = progressMatches.filter((match) => match.status === 'complete').length;
  if (unpublished) return <p role="alert">This event is unavailable or has not been published.</p>;
  return (
    <div className="ops-page player-event-hub">
      <PageHeader
        title={publicEvent.data?.plan.name ?? 'Your event'}
        description={
          empty ? 'Event information and results.' : 'Choose your name to find your matches.'
        }
      />
      {data && !empty && (
        <aside className="player-event-overview" aria-label="Event progress">
          <span>
            {selectedPool ? 'Pool progress' : 'Event progress'} · {progressComplete} /{' '}
            {progressMatches.length} sets complete
          </span>
          <progress
            aria-label="Sets completed"
            value={progressComplete}
            max={Math.max(1, progressMatches.length)}
          />
        </aside>
      )}
      <PlayerEventNavigation board={board} />
      {empty && <EmptyEventMatches historical={Boolean(data?.plan.historicalResultsSlug)} />}
      {claim && !empty && (
        <p>
          Your linked profile: <strong>{claim.playerName}</strong>.
        </p>
      )}
      {announcements.length > 0 && (
        <aside className="card event-announcements" aria-label="Announcements">
          <strong>Announcements</strong>
          <div>
            {announcements.map((item) => (
              <p key={item.id}>{item.message}</p>
            ))}
          </div>
        </aside>
      )}
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
            {reporter === 'guest' ? 'Use signed-in reporting' : 'Use venue guest pass'}
          </Button>
        </p>
      )}
      {closed && (
        <p className="card">
          This event is closed. Results remain available; ask a TO about corrections.
        </p>
      )}
      {reportingVisible && !playOpen && (
        <p className="card">
          Match reporting opens when the organiser locks or resumes the pool draw.
        </p>
      )}
      {reportingVisible && (reporter !== 'signed-in' || redeeming) && (
        <GuestPassStatus
          redeeming={redeeming}
          valid={valid}
          session={session}
          now={now}
          error={matches.isError ? matches.error.message : null}
          accessDenied={accessDenied}
        />
      )}
      {data && (
        <p
          className="event-connection player-event-connection"
          role={!online || publicEvent.isError ? 'alert' : 'status'}
        >
          {!online || publicEvent.isError
            ? 'Live updates interrupted. Scores shown may be out of date.'
            : 'Live event · results refresh automatically'}
        </p>
      )}
      {!data && !unpublished && (
        <GuestLoadState
          pending={publicEvent.isPending}
          onRetry={() => void publicEvent.refetch()}
        />
      )}
      {data && (
        <>
          {signedIn && !empty && !data.settings.playerReports && !guestCredential && (
            <p className="banner banner-warning">
              Signed-in reporting is off for this event. Scan the event QR for guest access or ask a
              TO to record your score.
            </p>
          )}
          {!empty && (
            <>
              <PlayerHubMatches hub={hub} data={data} />
              <section id="what-next" aria-label="What next">
                <PlayerNextSteps hub={hub} data={data} />
              </section>
            </>
          )}
          <PlayerHubBoard data={data} selectedPool={selectedPool} player={player} />
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

function PlayerEventNavigation({ board }: { board: PlayerEventHub['board'] }) {
  return (
    <nav className="player-event-nav" aria-label="Event sections">
      <a href="#my-matches">Find my matches</a>
      <a href="#what-next">What next</a>
      {(board?.sections ?? ['pools', 'brackets', 'results']).map((section) => (
        <a key={section} href={`#event-${section}`}>
          {{ pools: 'Pools', brackets: 'Brackets', results: 'Results' }[section]}
        </a>
      ))}
    </nav>
  );
}

function PlayerNextSteps({ hub, data }: { hub: PlayerEventHub; data: PublicEventSnapshot }) {
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
  const rounds = (
    <PoolRoundSchedule data={data} selectedPool={hub.selectedPool} playerId={hub.player} />
  );
  if (hub.closed)
    return (
      <Disclosure title="Schedule & station history">
        {queues}
        {rounds}
      </Disclosure>
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

function EmptyEventMatches({ historical }: { historical: boolean }) {
  return (
    <>
      <section id="my-matches" className="card" aria-label="Event schedule">
        <h2>Matches & results</h2>
        <p>
          No matches in this view yet.{' '}
          {historical
            ? 'Open Results below for the imported event standings.'
            : 'The organisers will publish pairings here when they are ready.'}
        </p>
      </section>
      <section id="what-next" aria-label="What next">
        <h2>What next</h2>
        <p>
          {historical
            ? 'This event uses imported results. Match reporting is closed.'
            : 'Check event announcements or ask an organiser about the next update.'}
        </p>
      </section>
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
  if (!valid || accessDenied)
    return (
      <section className="card">
        <h2>
          {session && !valid
            ? 'Your guest pass has expired'
            : error
              ? 'Refresh your guest pass'
              : 'Scan in to report a score'}
        </h2>
        <p>
          Scan a guest reporting QR at the venue or ask a TO for an active invitation to start
          matches and report scores. You can keep browsing without a pass.
        </p>
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
          Reporting connection interrupted. Your pass is saved; reporting resumes when the
          connection recovers.
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
