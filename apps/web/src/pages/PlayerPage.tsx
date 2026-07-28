import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { trpc } from '../lib/trpc';
import type { PlayerData, PlayerEventView } from '../lib/apiTypes';
import { formatDate, leagueClass } from '../lib/format';
import './PlayerPage.css';

export function PlayerPage() {
  const { playerId } = useParams({ from: '/players/$playerId' });
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['player', playerId],
    queryFn: () => trpc.public.player.query({ playerId }),
  });

  // Merged players redirect to their canonical record.
  const redirectTo = query.data && 'redirectTo' in query.data ? query.data.redirectTo : null;
  useEffect(() => {
    if (redirectTo) {
      void navigate({ to: '/players/$playerId', params: { playerId: redirectTo }, replace: true });
    }
  }, [redirectTo, navigate]);

  if (query.isPending) return <p className="loading-text">Loading player…</p>;
  if (query.isError) return <p className="error-text">Failed to load player: {query.error.message}</p>;
  if (query.data === null) return <p className="error-text">Player not found.</p>;
  if (redirectTo) return <p className="loading-text">Redirecting…</p>;

  return <PlayerProfile data={query.data as PlayerData} />;
}

function PlayerProfile({ data }: { data: PlayerData }) {
  const { player, rating } = data;
  // The server types these rows loosely (Record<string, unknown>); see PlayerEventView.
  const events = data.events as unknown as PlayerEventView[];

  const chartData = useMemo(
    () =>
      events.map((event, idx) => ({
        idx: idx + 1,
        tournament: event.tournamentName,
        date: formatDate(event.tournamentDate),
        result: event.isDecay ? 'decay' : event.won ? 'W' : 'L',
        opponent: event.opponentName,
        rating: event.postRating,
        floor: event.postRating - 2 * event.postRd,
        decayRating: event.isDecay ? event.postRating : null,
        rd: event.postRd,
      })),
    [events],
  );

  const matches = useMemo(() => events.filter((e) => !e.isDecay), [events]);
  const wins = matches.filter((e) => e.won).length;
  const winRate = matches.length > 0 ? ((wins / matches.length) * 100).toFixed(1) : null;

  const confidenceExplainer = useMemo(() => {
    if (!rating) return 'No rated match history yet.';
    const parts: string[] = [
      `Based on ${rating.tournamentCount} event(s), ${rating.uniqueOpponentCount} unique opponent(s), and ${rating.matchCount} total match(es).`,
    ];
    if (rating.rookieRatio > 0) {
      parts.push(`${(rating.rookieRatio * 100).toFixed(0)}% of matches are in rookie brackets.`);
      if (rating.isolationFactor > 0) {
        parts.push(
          `Isolation factor: ${(rating.isolationFactor * 100).toFixed(0)}% (rookie-only players with less main bracket exposure have higher uncertainty).`,
        );
      }
    }
    return parts.join(' ');
  }, [rating]);

  // Most recent first for the table.
  const tableEvents = useMemo(() => [...events].reverse(), [events]);

  return (
    <div className="player-page">
      <div className="profile-header">
        <div>
          <h1>
            {player.name}
            {player.verified && (
              <span className="verified-badge" title="Verified — claimed by their owner">
                {' '}
                ✓
              </span>
            )}
          </h1>
          <p className="company-tag">
            {player.companyName ?? player.companyCode ?? 'No company'}
            {rating && (
              <>
                {' · '}
                <span className={`league-badge ${leagueClass(rating.league)}`}>{rating.league}</span>
                {' · '}Rank #{rating.rank}
              </>
            )}
          </p>
        </div>
      </div>

      <div className="profile-stats">
        <div className="stat-card">
          <div className="stat-label">Conservative Rating</div>
          <div className="stat-value">{rating ? rating.conservativeRating.toFixed(0) : '—'}</div>
          <div className="stat-detail">
            {rating ? `Rating ${rating.rating.toFixed(0)} · RD ${rating.effectiveRd.toFixed(0)}` : 'Unrated'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Record</div>
          <div className="stat-value">{rating ? `${rating.wins}-${rating.losses}` : `${wins}-${matches.length - wins}`}</div>
          <div className="stat-detail">{winRate != null ? `${winRate}% win rate` : 'No matches'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Events</div>
          <div className="stat-value">{rating ? rating.tournamentCount : '—'}</div>
          <div className="stat-detail">
            {rating ? `${rating.mainMatchCount} main / ${rating.rookieMatchCount} rookie sets` : ''}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Confidence</div>
          <div className="stat-value">{rating ? `${(rating.sampleConfidence * 100).toFixed(0)}%` : '—'}</div>
          <div className="stat-detail">{confidenceExplainer}</div>
        </div>
      </div>

      {chartData.length > 0 && (
        <div className="rating-chart card section">
          <h3>Rating History</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="idx" label={{ value: 'Rating event #', position: 'insideBottom', offset: -5 }} />
              <YAxis label={{ value: 'Rating', angle: -90, position: 'insideLeft' }} domain={['auto', 'auto']} />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const d = payload[0]!.payload as (typeof chartData)[number];
                    return (
                      <div className="custom-tooltip">
                        <p>
                          <strong>{d.tournament}</strong>
                        </p>
                        <p>
                          {d.date} —{' '}
                          {d.result === 'decay' ? 'inactivity decay' : `${d.result} vs ${d.opponent ?? 'unknown'}`}
                        </p>
                        <p>Rating: {d.rating.toFixed(0)}</p>
                        <p>Rating floor: {d.floor.toFixed(0)}</p>
                        <p>RD: {d.rd.toFixed(1)}</p>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Legend />
              <Line type="monotone" dataKey="rating" stroke="#3498db" name="Rating" dot={{ r: 3 }} />
              <Line
                type="monotone"
                dataKey="floor"
                stroke="#e74c3c"
                name="Rating floor (rating − 2×RD)"
                strokeDasharray="5 5"
                dot={{ r: 2 }}
              />
              <Line
                type="monotone"
                dataKey="decayRating"
                stroke="#f39c12"
                name="Inactivity decay"
                strokeWidth={0}
                dot={{ r: 5, fill: '#f39c12' }}
                activeDot={false}
                legendType="circle"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="match-history section">
        <h3>Match History ({matches.length} sets)</h3>
        {events.length === 0 ? (
          <p className="muted">No match history available for this player.</p>
        ) : (
          <div className="match-history-scroll">
            <table className="match-table data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Tournament</th>
                  <th>Opponent</th>
                  <th>Result</th>
                  <th>Rating Change</th>
                </tr>
              </thead>
              <tbody>
                {tableEvents.map((event) => {
                  const ratingChange = event.postRating - event.preRating;
                  const rdChange = event.postRd - event.preRd;
                  return (
                    <tr key={event.seq} className={event.isDecay ? 'decay' : event.won ? 'win' : 'loss'}>
                      <td>{formatDate(event.tournamentDate)}</td>
                      <td>
                        {event.tournamentName}
                        {event.isRookie && <span className="chip chip-warning rookie-chip">rookie</span>}
                      </td>
                      <td>
                        {event.isDecay ? (
                          <em>Inactivity decay</em>
                        ) : event.opponentPlayerId ? (
                          <Link to="/players/$playerId" params={{ playerId: event.opponentPlayerId }}>
                            {event.opponentName ?? 'Unknown'}
                          </Link>
                        ) : (
                          (event.opponentName ?? 'Unknown')
                        )}
                      </td>
                      <td className={event.isDecay ? 'result-decay' : event.won ? 'result-win' : 'result-loss'}>
                        {event.isDecay ? '—' : event.won ? 'W' : 'L'}
                      </td>
                      <td className={ratingChange >= 0 ? 'rating-up' : 'rating-down'}>
                        {ratingChange >= 0 ? '+' : ''}
                        {ratingChange.toFixed(1)}
                        {event.isDecay && rdChange > 0 && <span className="rd-decay"> (RD +{rdChange.toFixed(1)})</span>}
                        {!event.isDecay && event.weight != null && event.weight < 0.99 && (
                          <span className="weight-indicator" title={`Match weight: ${(event.weight * 100).toFixed(0)}%`}>
                            {' '}
                            ×{event.weight.toFixed(2)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
