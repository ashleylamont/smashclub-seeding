import { useQuery } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import './EventNights.css';

const closed = (status: string) => ['complete', 'cancelled'].includes(status);
export function EventNightsPage() {
  const events = useQuery({ queryKey: ['publicEventNights'], queryFn: () => trpc.eventOps.publicEvents.query(), refetchInterval: 15_000, retry: false });
  const open = events.data?.filter(event => !closed(event.status)) ?? [];
  const finished = events.data?.filter(event => closed(event.status)) ?? [];
  return <div className="event-nights"><header><span className="eyebrow">NEMESIS / EVENT NIGHT</span><h1>Find your event</h1><p>Find your pool, follow station queues, check standings and report results. No account needed.</p><p className="muted">Scan the event’s reporting QR to start eligible matches and submit scores as a guest. Browsing does not need a pass.</p></header>
    {events.isPending && <p>Loading published events…</p>}
    {events.isError && <p role="alert">The event list could not be refreshed. <button className="btn" onClick={() => void events.refetch()}>Try again</button></p>}
    <section aria-label="Open event nights"><h2>Open events</h2>{!events.isPending && !events.isError && !open.length && <p>No events are published for play yet. Your TO can publish tonight’s event when it is ready.</p>}<div className="event-nights-grid">{open.map(event => <article className="card" key={event.id}><h3>{event.name}</h3><p>{new Date(event.eventDate).toLocaleDateString(undefined, { dateStyle: 'medium' })} · {event.status.replaceAll('_', ' ')}</p><a className="btn btn-primary" href={`/play/${event.id}`}>Open player hub</a><a href={`/live/${event.id}`}>Public event board →</a></article>)}</div></section>
    {finished.length > 0 && <details><summary>Recent finished events ({finished.length})</summary><div className="event-nights-grid">{finished.map(event => <article className="card" key={event.id}><h3>{event.name}</h3><p>{new Date(event.eventDate).toLocaleDateString(undefined, { dateStyle: 'medium' })} · {event.status === 'cancelled' ? 'Cancelled' : 'Finished'}</p><a href={`/live/${event.id}`}>View results and event board →</a></article>)}</div></details>}
  </div>;
}
