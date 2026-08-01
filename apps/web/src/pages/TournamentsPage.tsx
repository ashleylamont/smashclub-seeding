import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import type { TournamentListItem } from '../lib/apiTypes';
import { formatDate, timeAgo } from '../lib/format';
import { syncStateLabel } from '../lib/labels';
import { bucketFor } from '../lib/tournamentBuckets';
import { useNow } from '../lib/useNow';
import './Tournaments.css';

export function TournamentsPage() {
  const query = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => trpc.public.tournaments.query(),
  });

  // A ticking clock rather than a read during render: a live window that
  // expires while this page is open has to actually move the tournament out of
  // the Live group.
  const now = useNow();

  const groups = useMemo(() => {
    const all = query.data ?? [];
    const live = all.filter((t) => bucketFor(t, now) === 'live');
    const upcoming = all
      .filter((t) => bucketFor(t, now) === 'upcoming')
      .sort((a, b) => (a.eventDate ?? '9999').localeCompare(b.eventDate ?? '9999'));
    // Newest first, and stated as such on the page — so it is sorted here
    // rather than inherited from whatever order the API happened to return.
    const completed = all
      .filter((t) => bucketFor(t, now) === 'completed')
      .sort((a, b) => (b.eventDate ?? '').localeCompare(a.eventDate ?? ''));
    return { live, upcoming, completed };
  }, [query.data, now]);

  if (query.isPending) return <p className="loading-text">Loading tournaments…</p>;
  if (query.isError) return <p className="error-text">Failed to load tournaments: {query.error.message}</p>;

  if (query.data.length === 0) {
    return (
      <div>
        <h1>Tournaments</h1>
        <p className="muted">No tournaments registered yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Tournaments</h1>
        <p className="muted page-header-note">
          Club nights, newest results first. Ratings count every set in these brackets.
        </p>
      </div>
      {groups.live.length > 0 && <TournamentGroup title="Live" items={groups.live} live />}
      {groups.upcoming.length > 0 && <TournamentGroup title="Upcoming" items={groups.upcoming} />}
      {groups.completed.length > 0 && <TournamentGroup title="Completed" items={groups.completed} />}
    </div>
  );
}

function TournamentGroup({ title, items, live }: { title: string; items: TournamentListItem[]; live?: boolean }) {
  return (
    <div className="section">
      {/* The count belongs on the heading: three groups of unknown size, one of
          which is usually much longer than the other two. */}
      <h2>
        {title} <span className="group-count num">{items.length}</span>
      </h2>
      <div className="tournament-list">
        {items.map((t) => {
          const sync = syncStateLabel(t.syncState);
          return (
            <Link key={t.id} to="/tournaments/$slug" params={{ slug: t.slug }} className="tournament-row">
              <div className="tournament-row-main">
                <span className="tournament-name">{t.name}</span>
                <span className="tournament-tags">
                  {live && <span className="live-badge">LIVE</span>}
                  {t.isRookie && (
                    <span className="chip chip-warning" title="A beginners' bracket — sets in it are weighted differently">
                      rookie
                    </span>
                  )}
                </span>
              </div>
              <div className="tournament-row-meta">
                <span>{formatDate(t.eventDate)}</span>
                {/* `sync: registered` was database vocabulary on a public page.
                    The state is worth showing — it says whether these results
                    have reached the ratings — but only in words. */}
                <span className="muted" title={sync.hint}>
                  {sync.label}
                  {t.lastSyncedAt ? ` · ${timeAgo(t.lastSyncedAt)}` : ''}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
