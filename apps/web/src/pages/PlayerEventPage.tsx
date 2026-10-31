import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState, Notice } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { useParams } from '@tanstack/react-router';
import { PlayerHubMatches } from '../components/PlayerHubMatches';
import { PlayerHubBoard } from '../components/PlayerHubBoard';
import { PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import { usePlayerEventHub } from '../lib/usePlayerEventHub';
import { guestTimeLeft, type GuestSession } from '../lib/guestReporting';
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
    stationId,
    player,
    start,
    chooseMatch,
    starting,
    canWrite,
    error,
  } = hub;
  if (unpublished) return <p role="alert">This event is unavailable or has not been published.</p>;
  return (
    <div className="ops-page player-event-hub">
      <PageHeader
        title={publicEvent.data?.plan.name ?? 'Your event'}
        description="Choose your name to find your matches."
      />
      <nav className="player-event-nav" aria-label="Event sections">
        <a href="#my-matches">Find my matches</a>
        <a href="#what-next">What next</a>
        <a href="#event-pools">Pools</a>
        <a href="#event-brackets">Brackets</a>
        <a href="#event-results">Results</a>
      </nav>
      {claim && (
        <p>
          Your linked profile: <strong>{claim.playerName}</strong>.
        </p>
      )}
      {data?.announcements.length ? (
        <aside className="card" aria-label="Announcements">
          {data.announcements
            .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
            .map((item) => (
              <p key={item.id}>{item.message}</p>
            ))}
        </aside>
      ) : null}
      {reporter && !closed && (
        <p className="muted">
          {reporter === 'guest'
            ? 'Reporting with your venue guest pass.'
            : 'Reporting with your signed-in account.'}
        </p>
      )}
      {session && signedCredential && (valid || reporter === 'guest') && (
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
      {!closed && !playOpen && (
        <p className="card">
          Match reporting opens when the organiser locks or resumes the pool draw.
        </p>
      )}
      {!closed && (reporter !== 'signed-in' || redeeming) && (
        <GuestPassStatus
          redeeming={redeeming}
          valid={valid}
          session={session}
          now={now}
          error={matches.isError ? matches.error.message : null}
          accessDenied={accessDenied}
        />
      )}
      {(!online || publicEvent.isError) && !unpublished && data && (
        <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>
      )}
      {!data && !unpublished && (
        <GuestLoadState
          pending={publicEvent.isPending}
          onRetry={() => void publicEvent.refetch()}
        />
      )}
      {data && (
        <>
          {signedIn && !data.settings.playerReports && !guestCredential && (
            <p className="banner banner-warning">
              Signed-in reporting is off for this event. Scan the event QR for guest access or ask a
              TO to record your score.
            </p>
          )}
          <PlayerHubMatches hub={hub} data={data} />
          <section id="what-next" aria-label="What next">
            <PoolStationQueue
              data={data}
              selectedPool={selectedPool}
              stationId={stationId}
              playerId={player}
              onStart={(input) => void start(input)}
              onReport={chooseMatch}
              pendingMatchId={starting}
              disabled={!canWrite}
            />
            <PoolRoundSchedule data={data} selectedPool={selectedPool} playerId={player} />
          </section>
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
