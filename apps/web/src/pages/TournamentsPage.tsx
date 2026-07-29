import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import type { TournamentListItem } from '../lib/apiTypes';
import { formatDate, timeAgo } from '../lib/format';
import './Tournaments.css';

type Bucket = 'live' | 'upcoming' | 'completed';

function bucketFor(t: TournamentListItem): Bucket {
  if (t.challongeState === 'complete') return 'completed';
  if (t.syncState === 'live' || t.challongeState === 'underway' || t.challongeState === 'awaiting_review') {
    return 'live';
  }
  return 'upcoming';
}

export function TournamentsPage() {
  const query = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => trpc.public.tournaments.query(),
  });

  const groups = useMemo(() => {
    const all = query.data ?? [];
    const live = all.filter((t) => bucketFor(t) === 'live');
    const upcoming = all
      .filter((t) => bucketFor(t) === 'upcoming')
      .sort((a, b) => (a.eventDate ?? '9999').localeCompare(b.eventDate ?? '9999'));
    const completed = all.filter((t) => bucketFor(t) === 'completed');
    return { live, upcoming, completed };
  }, [query.data]);

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
      <h1>Tournaments</h1>
      {groups.live.length > 0 && <TournamentGroup title="Live" items={groups.live} live />}
      {groups.upcoming.length > 0 && <TournamentGroup title="Upcoming" items={groups.upcoming} />}
      {groups.completed.length > 0 && <TournamentGroup title="Completed" items={groups.completed} />}
    </div>
  );
}

function TournamentGroup({ title, items, live }: { title: string; items: TournamentListItem[]; live?: boolean }) {
  return (
    <div className="section">
      <h2>{title}</h2>
      <div className="tournament-list">
        {items.map((t) => (
          <Link key={t.id} to="/tournaments/$slug" params={{ slug: t.slug }} className="tournament-row">
            <div className="tournament-row-main">
              <span className="tournament-name">{t.name}</span>
              <span className="tournament-tags">
                {live && <span className="live-badge">LIVE</span>}
                {t.isRookie && <span className="chip chip-warning">rookie</span>}
              </span>
            </div>
            <div className="tournament-row-meta">
              <span>{formatDate(t.eventDate)}</span>
              <span className="muted">
                sync: {t.syncState}
                {t.lastSyncedAt ? ` · ${timeAgo(t.lastSyncedAt)}` : ''}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
