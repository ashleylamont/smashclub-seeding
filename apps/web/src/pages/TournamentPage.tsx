import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import type { TournamentData, TournamentSet } from '../lib/apiTypes';
import { formatDate, formatDateTime, roundLabel, timeAgo } from '../lib/format';
import { useEventSource } from '../lib/useEventSource';
import './Tournaments.css';

export function TournamentPage() {
  const { slug } = useParams({ from: '/tournaments/$slug' });
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['tournament', slug],
    queryFn: () => trpc.public.tournament.query({ slug }),
  });

  const isLive = query.data?.syncState === 'live';
  useEventSource(isLive && query.data ? `/api/live/${query.data.id}` : null, (type) => {
    if (type === 'set_updated' || type === 'sync_completed') {
      void queryClient.invalidateQueries({ queryKey: ['tournament', slug] });
    }
  });

  if (query.isPending) return <p className="loading-text">Loading tournament…</p>;
  if (query.isError) return <p className="error-text">Failed to load tournament: {query.error.message}</p>;
  if (query.data === null) return <p className="error-text">Tournament not found.</p>;

  return <TournamentDetail data={query.data} />;
}

function TournamentDetail({ data }: { data: TournamentData }) {
  const isLive = data.syncState === 'live';
  const isComplete = data.challongeState === 'complete';

  const standings = useMemo(() => {
    if (!isComplete) return [];
    return data.participants.filter((p) => p.finalRank != null);
  }, [data.participants, isComplete]);

  const recentSets = useMemo(
    () =>
      data.sets
        .filter((s) => s.state === 'complete' && s.completedAt != null)
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
        .slice(0, 8),
    [data.sets],
  );

  return (
    <div>
      <div className="page-header">
        <h1>{data.name}</h1>
        <span className="tournament-tags">
          {isLive && <span className="live-badge">LIVE</span>}
          {data.isRookie && <span className="chip chip-warning">rookie</span>}
          <span className="chip">{data.challongeState ?? 'pending'}</span>
        </span>
      </div>
      <p className="muted tournament-subtitle">
        {formatDate(data.eventDate)} · sync: {data.syncState}
        {data.lastSyncedAt ? ` (${timeAgo(data.lastSyncedAt)})` : ''}
      </p>

      {isLive && recentSets.length > 0 && (
        <div className="section card live-feed">
          <h3>
            <span className="live-badge">LIVE</span> Recent results
          </h3>
          <ul className="live-feed-list">
            {recentSets.map((set) => (
              <li key={set.id}>
                <SetLine set={set} />
                <span className="muted"> — {timeAgo(set.completedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {standings.length > 0 && (
        <div className="section">
          <h2>Standings</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Place</th>
                  <th>Player</th>
                  <th>Seed</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((p) => (
                  <tr key={p.id}>
                    <td>{p.finalRank}</td>
                    <td>
                      <ParticipantName name={p.name} playerId={p.playerId} />
                    </td>
                    <td>{p.challongeSeed ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!isComplete && data.participants.length > 0 && (
        <div className="section">
          <h2>Participants ({data.participants.length})</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Seed</th>
                  <th>Player</th>
                </tr>
              </thead>
              <tbody>
                {[...data.participants]
                  .sort((a, b) => (a.challongeSeed ?? 1e9) - (b.challongeSeed ?? 1e9))
                  .map((p) => (
                    <tr key={p.id}>
                      <td>{p.challongeSeed ?? '—'}</td>
                      <td>
                        <ParticipantName name={p.name} playerId={p.playerId} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section">
        <h2>Sets ({data.sets.length})</h2>
        {data.sets.length === 0 ? (
          <p className="muted">No sets yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Set</th>
                  <th>Match</th>
                  <th>Score</th>
                  <th>State</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.sets.map((set) => (
                  <tr key={set.id} className={set.excludedFromRatings ? 'set-excluded' : undefined}>
                    <td>{set.round != null ? roundLabel(set.round) : '—'}</td>
                    <td>{set.identifier ?? '—'}</td>
                    <td>
                      <SetLine set={set} />
                      {set.excludedFromRatings && (
                        <span className="chip chip-danger excluded-chip" title="Excluded from ratings">
                          excluded
                        </span>
                      )}
                    </td>
                    <td>{set.scoresCsv ?? '—'}</td>
                    <td>{set.state}</td>
                    <td>{set.completedAt ? formatDateTime(set.completedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ParticipantName({ name, playerId }: { name: string; playerId: string | null }) {
  if (!playerId) return <>{name}</>;
  return (
    <Link to="/players/$playerId" params={{ playerId }}>
      {name}
    </Link>
  );
}

function SetLine({ set }: { set: TournamentSet }) {
  const p1 = set.p1Name ?? 'TBD';
  const p2 = set.p2Name ?? 'TBD';
  return (
    <span className="set-line">
      <span className={set.winner === 1 ? 'set-winner' : undefined}>{p1}</span>
      <span className="muted"> vs </span>
      <span className={set.winner === 2 ? 'set-winner' : undefined}>{p2}</span>
    </span>
  );
}
