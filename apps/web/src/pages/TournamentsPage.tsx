import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import type { TournamentListItem } from '../lib/apiTypes';
import { formatDate, timeAgo } from '../lib/format';
import './Tournaments.css';

type Bucket = 'live' | 'upcoming' | 'completed';

/**
 * "Live" is an explicit, expiring admin decision (`liveUntil`) — NEVER inferred
 * from Challonge's state.
 *
 * Challonge's `underway` and `awaiting_review` are sticky: a bracket nobody
 * closed properly still reports them years later. Inferring liveness from them
 * listed 2024 tournaments under "Live" (and previously drove a 15s poll loop
 * against a rate-limited API). A past-dated bracket that upstream never closed
 * is shown as completed — which is what it actually is — and the row still
 * displays its real sync state.
 */
export function bucketFor(t: TournamentListItem, now: number = Date.now()): Bucket {
  if (t.liveUntil && new Date(t.liveUntil).getTime() > now) return 'live';
  if (t.challongeState === 'complete') return 'completed';
  const eventTime = t.eventDate ? new Date(t.eventDate).getTime() : null;
  if (eventTime !== null && eventTime < now) return 'completed';
  return 'upcoming';
}

export function TournamentsPage() {
  const query = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => trpc.public.tournaments.query(),
  });

  const groups = useMemo(() => {
    const all = query.data ?? [];
    const now = Date.now();
    const live = all.filter((t) => bucketFor(t, now) === 'live');
    const upcoming = all
      .filter((t) => bucketFor(t, now) === 'upcoming')
      .sort((a, b) => (a.eventDate ?? '9999').localeCompare(b.eventDate ?? '9999'));
    const completed = all.filter((t) => bucketFor(t, now) === 'completed');
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
