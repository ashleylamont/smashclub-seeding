import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { formatDate } from '../lib/format';
import { syncStateLabel } from '../lib/labels';
import { groupTournamentsByEvent, type TournamentEventGroup } from '../lib/eventGrouping';
import { useNow } from '../lib/useNow';
import type { TournamentListItem } from '../lib/apiTypes';
import { ArchiveQueryContent, type ArchivePageFeedback } from './ArchiveQueryContent';
import './Tournaments.css';

export function TournamentsPage() {
  const query = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => trpc.public.tournaments.query(),
  });
  return <ArchiveQueryContent kind="tournaments" query={query} content={Tournaments} />;
}

function Tournaments({
  data: tournaments,
  headingRef,
  refreshNotice,
}: { data: TournamentListItem[] } & ArchivePageFeedback) {
  // A ticking clock rather than a read during render: a live window that
  // expires while this page is open has to actually move the tournament out of
  // the Live group.
  const now = useNow();

  const groups = useMemo(() => {
    const events = groupTournamentsByEvent(tournaments, now);
    const live = events.filter((t) => t.bucket === 'live');
    const upcoming = events
      .filter((t) => t.bucket === 'upcoming')
      .sort((a, b) => (a.eventDate ?? '9999').localeCompare(b.eventDate ?? '9999'));
    // Newest first, and stated as such on the page — so it is sorted here
    // rather than inherited from whatever order the API happened to return.
    const completed = events
      .filter((t) => t.bucket === 'completed')
      .sort((a, b) => (b.eventDate ?? '').localeCompare(a.eventDate ?? ''));
    return { live, upcoming, completed };
  }, [tournaments, now]);

  if (tournaments.length === 0) {
    return (
      <div>
        <h1 ref={headingRef} tabIndex={-1}>
          Tournaments
        </h1>
        {refreshNotice}
        <p className="muted">No tournaments registered yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 ref={headingRef} tabIndex={-1}>
          Tournaments
        </h1>
        <p className="muted page-header-note">
          Club nights, newest results first. Ratings count eligible played sets in these brackets.
        </p>
      </div>
      {refreshNotice}
      {groups.live.length > 0 && <TournamentGroup title="Live" items={groups.live} />}
      {groups.upcoming.length > 0 && <TournamentGroup title="Upcoming" items={groups.upcoming} />}
      {groups.completed.length > 0 && (
        <TournamentGroup title="Completed" items={groups.completed} />
      )}
    </div>
  );
}

function TournamentGroup({ title, items }: { title: string; items: TournamentEventGroup[] }) {
  return (
    <div className="section">
      {/* The count belongs on the heading: three groups of unknown size, one of
          which is usually much longer than the other two. */}
      <h2>
        {title} <span className="group-count num">{items.length}</span>
      </h2>
      <div className="tournament-list">
        {items.map((event) => {
          const sync = event.items.every((t) => t.syncState === 'synced')
            ? syncStateLabel('synced')
            : syncStateLabel('registered');
          return (
            <div key={event.key} className="tournament-event-card">
              <div className="tournament-row-main">
                <Link to="/events/$slug" params={{ slug: event.slug }} className="tournament-name">
                  {event.title}
                </Link>
                <span className="tournament-tags">
                  {event.live && <span className="live-badge">LIVE</span>}
                  {event.items.some((t) => t.isRookie) && (
                    <span className="chip chip-warning">rookie bracket</span>
                  )}
                </span>
              </div>
              <div className="tournament-row-meta">
                <span>{formatDate(event.eventDate)}</span>
                <span className="muted">{sync.label}</span>
              </div>
              <div className="event-brackets">
                {event.items.map((t) => (
                  <Link
                    key={t.id}
                    to="/tournaments/$slug"
                    params={{ slug: t.slug }}
                    className="event-bracket-link"
                  >
                    {t.name}
                  </Link>
                ))}
                <Link
                  to="/recaps/$slug"
                  params={{ slug: event.slug }}
                  className="tournament-recap-link"
                >
                  Recap →
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
