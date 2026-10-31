import { Link } from '@tanstack/react-router';
import { liveEventNights, usePublicEventNights } from '../lib/publicEvents';
import { useNow } from '../lib/useNow';
import { Button } from './ui/Button';
import './LiveEventEntry.css';

/** Public entry to the existing player hub, including any saved venue pass. */
export function LiveEventEntry() {
  const events = usePublicEventNights();
  const now = useNow(15_000);
  const live = liveEventNights(events.data ?? [], now);
  const active = !events.isError && live.length > 0;
  return (
    <section
      className={`home-live${active ? ' home-live-active' : ''}`}
      aria-labelledby="home-live-title"
    >
      <div className="home-live-heading">
        <h2 id="home-live-title">Currently live</h2>
        <Link to="/play" className="home-live-browse">
          All events →
        </Link>
      </div>
      {events.isPending ? (
        <p className="muted" role="status">
          Checking for live tournaments…
        </p>
      ) : events.isError ? (
        <p role="alert">
          Live events could not be refreshed.{' '}
          <Button variant="plain" className="link-button" onClick={() => void events.refetch()}>
            Try again
          </Button>
        </p>
      ) : live.length === 0 ? (
        <p className="muted">No tournament is live right now.</p>
      ) : (
        <>
          {live.length > 1 && (
            <p className="muted">{live.length} live tournaments · choose yours.</p>
          )}
          <ul className="home-live-events">
            {live.map((event) => (
              <li key={event.id}>
                <div className="home-live-identity" id={`home-live-${event.id}`}>
                  <h3>{event.name}</h3>
                  <p className="muted">
                    {event.competitionFormat === 'doubles' ? 'Doubles' : 'Singles'} ·{' '}
                    {new Date(event.eventDate).toLocaleDateString(undefined, {
                      dateStyle: 'medium',
                    })}
                  </p>
                </div>
                <Button asChild variant="primary">
                  <Link
                    to="/play/$planId"
                    params={{ planId: event.id }}
                    aria-describedby={`home-live-${event.id}`}
                  >
                    Open live tournament
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
