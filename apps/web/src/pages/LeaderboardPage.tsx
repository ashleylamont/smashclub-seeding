import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import { timeAgo } from '../lib/format';
import { Leaderboard } from '../components/Leaderboard';
import { RatingsOverTime } from '../components/RatingsOverTime';

export function LeaderboardPage() {
  const leaderboard = useQuery({
    queryKey: ['leaderboard'],
    queryFn: () => trpc.public.leaderboard.query(),
  });
  const ratingHistory = useQuery({
    queryKey: ['ratingHistory'],
    queryFn: () => trpc.public.ratingHistory.query(),
  });
  const tournaments = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => trpc.public.tournaments.query(),
  });

  const tournamentNames = useMemo(
    () => new Map((tournaments.data ?? []).map((t) => [t.id, t.name])),
    [tournaments.data],
  );

  if (leaderboard.isPending) return <p className="loading-text">Loading rankings…</p>;
  if (leaderboard.isError) return <p className="error-text">Failed to load rankings: {leaderboard.error.message}</p>;

  const { computedAt, rows } = leaderboard.data;

  return (
    <div>
      <div className="page-header">
        <h1>Rankings</h1>
        <span className="muted">{computedAt ? `Updated ${timeAgo(computedAt)}` : 'No recompute yet'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No ranked players yet. Once a tournament is synced and ratings computed, they show up here.</p>
      ) : (
        <Leaderboard rows={rows} />
      )}
      {ratingHistory.data && <RatingsOverTime history={ratingHistory.data} tournamentNames={tournamentNames} />}
    </div>
  );
}
