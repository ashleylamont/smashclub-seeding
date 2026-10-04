import { Button } from '../components/ui/Button';
import { Disclosure } from '../components/ui/Disclosure';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import './EventNights.css';

const closed = (status: string) => ['complete', 'cancelled'].includes(status);
export function EventNightsPage() {
  const events = useQuery({
    queryKey: ['publicEventNights'],
    queryFn: () => trpc.eventOps.publicEvents.query(),
    refetchInterval: 15_000,
    retry: false,
  });
  const open = events.data?.filter((event) => !closed(event.status)) ?? [];
  const finished = events.data?.filter((event) => closed(event.status)) ?? [];
  return (
    <div className="event-nights">
      <header>
        <h1>Events</h1>
        <p>Choose an event to find your matches and results.</p>
        <p className="muted">Scan the event QR to report scores as a guest.</p>
      </header>
      {events.isPending && <p>Loading published events…</p>}
      {events.isError && (
        <p role="alert">
          The event list could not be refreshed.{' '}
          <Button type="submit" onClick={() => void events.refetch()}>
            Try again
          </Button>
        </p>
      )}
      <section aria-label="Open event nights">
        <h2>Open events</h2>
        {!events.isPending && !events.isError && !open.length && (
          <p>No events are published yet.</p>
        )}
        <div className="event-nights-grid">
          {open.map((event) => (
            <article className="card" key={event.id}>
              <h3>{event.name}</h3>
              <p>
                {new Date(event.eventDate).toLocaleDateString(undefined, { dateStyle: 'medium' })} ·{' '}
                {event.status.replaceAll('_', ' ')}
              </p>
              <a className="btn btn-primary" href={`/play/${event.id}`}>
                Open event
              </a>
              <a href={`/live/${event.id}`}>Public event board →</a>
            </article>
          ))}
        </div>
      </section>
      {finished.length > 0 && (
        <Disclosure title={<> Recent finished events ({finished.length}) </>}>
          <div className="event-nights-grid">
            {finished.map((event) => (
              <article className="card" key={event.id}>
                <h3>{event.name}</h3>
                <p>
                  {new Date(event.eventDate).toLocaleDateString(undefined, { dateStyle: 'medium' })}{' '}
                  · {event.status === 'cancelled' ? 'Cancelled' : 'Finished'}
                </p>
                <a href={`/live/${event.id}`}>View results and event board →</a>
              </article>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
