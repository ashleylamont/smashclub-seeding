import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { trpc } from '../lib/trpc';
import type { PlayerData, PlayerEventView } from '../lib/apiTypes';
import { formatDate, tierClass } from '../lib/format';
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

  /**
   * The trajectory. One series — the skill estimate — inside a shaded ±2 SD
   * band, so the uncertainty is visible as width rather than being subtracted
   * into a separate "floor" line that reads as a second, competing rating.
   */
  const chartData = useMemo(
    () =>
      events.map((event, idx) => ({
        idx: idx + 1,
        tournament: event.tournamentName,
        date: formatDate(event.tournamentDate),
        result: event.isDecay ? 'decay' : event.won ? 'W' : 'L',
        opponent: event.opponentName,
        rating: event.postRating,
        band: [event.postRating - 2 * event.postRd, event.postRating + 2 * event.postRd] as [number, number],
        decayRating: event.isDecay ? event.postRating : null,
        rd: event.postRd,
      })),
    [events],
  );

  /** Event indices where a new tournament starts, drawn as vertical rules. */
  const eventBoundaries = useMemo(() => {
    const marks: number[] = [];
    events.forEach((event, idx) => {
      if (idx > 0 && event.tournamentId !== events[idx - 1]!.tournamentId) marks.push(idx + 1);
    });
    return marks;
  }, [events]);

  const matches = useMemo(() => events.filter((e) => !e.isDecay), [events]);
  const wins = matches.filter((e) => e.won).length;
  const winRate = matches.length > 0 ? ((wins / matches.length) * 100).toFixed(0) : null;

  const confidenceExplainer = useMemo(() => {
    if (!rating) return 'No rated match history yet.';
    const parts: string[] = [
      `${rating.tournamentCount} bracket(s), ${rating.uniqueOpponentCount} unique opponent(s), ${rating.matchCount} set(s).`,
    ];
    if (rating.rookieRatio > 0) {
      parts.push(`${(rating.rookieRatio * 100).toFixed(0)}% of sets in rookie brackets.`);
      if (rating.isolationFactor > 0) {
        parts.push(
          `Isolation ${(rating.isolationFactor * 100).toFixed(0)}% — rookie-only players with little main-bracket exposure carry more uncertainty.`,
        );
      }
    }
    return parts.join(' ');
  }, [rating]);

  // Most recent first for the table.
  const tableEvents = useMemo(() => [...events].reverse(), [events]);

  return (
    <div className="player-page">
      <header className="profile-header">
        <div className="profile-identity">
          <p className="eyebrow">
            {rating ? `Rank #${rating.rank}` : 'Unrated'}
            {player.companyCode ? ` · ${player.companyCode}` : ''}
          </p>
          <h1 className="profile-name">
            {player.name}
            {player.verified && (
              <span className="verified-badge" title="Verified — claimed by their owner">
                {' '}
                ✓
              </span>
            )}
          </h1>
          <p className="muted profile-company">
            {player.companyName ?? player.companyCode ?? 'No company'}
            {rating && (
              <>
                {' · '}
                <span className={`chip ${tierClass(rating.league)}`}>{rating.league}</span>
              </>
            )}
          </p>
        </div>

        {/* The headline figure is the skill estimate with its uncertainty
            beside it — the same number the leaderboard ranks on. */}
        {rating && (
          <div className="profile-headline">
            <span className="headline-label">Skill</span>
            <span className="headline-value num">{rating.skillRating.toFixed(0)}</span>
            <span className="headline-band num">± {rating.skillSd.toFixed(0)}</span>
          </div>
        )}
      </header>

      <dl className="profile-stats">
        <div className="stat">
          <dt>Seeding rating</dt>
          <dd className="num">{rating ? rating.conservativeRating.toFixed(0) : '—'}</dd>
          <p className="stat-detail">Cautious estimate — what brackets are seeded on.</p>
        </div>
        <div className="stat">
          <dt>Record</dt>
          <dd className="num">
            {rating ? `${rating.wins}–${rating.losses}` : `${wins}–${matches.length - wins}`}
          </dd>
          <p className="stat-detail">{winRate != null ? `${winRate}% of sets won` : 'No sets played'}</p>
        </div>
        <div className="stat">
          <dt>Events</dt>
          <dd className="num">{rating ? rating.eventCount : '—'}</dd>
          <p className="stat-detail">
            {rating
              ? [
                  // Only worth stating when it differs — i.e. when they entered
                  // both the main and the rookie bracket on one evening.
                  rating.tournamentCount !== rating.eventCount
                    ? `${rating.tournamentCount} brackets`
                    : null,
                  `${rating.mainMatchCount} main / ${rating.rookieMatchCount} rookie sets`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : ''}
          </p>
        </div>
        <div className="stat">
          <dt>Confidence</dt>
          <dd className="num">{rating ? `${(rating.sampleConfidence * 100).toFixed(0)}%` : '—'}</dd>
          <p className="stat-detail">{confidenceExplainer}</p>
        </div>
      </dl>

      {chartData.length > 0 && (
        <section className="section rating-chart">
          <h3>Rating trajectory</h3>
          <p className="muted chart-caption">
            Skill estimate after every set. The shaded band is ±2 standard deviations — it narrows as we see
            more results. Vertical rules mark the start of each event.
          </p>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              {eventBoundaries.map((mark) => (
                <ReferenceLine key={mark} x={mark} stroke="var(--chart-grid)" />
              ))}
              <XAxis
                dataKey="idx"
                tick={{ fill: 'var(--text-soft)', fontSize: 11 }}
                stroke="var(--border-strong)"
                tickLine={false}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: 'var(--text-soft)', fontSize: 11 }}
                stroke="var(--border-strong)"
                tickLine={false}
                width={48}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0]!.payload as (typeof chartData)[number];
                  return (
                    <div className="custom-tooltip">
                      <p className="tooltip-label">{d.tournament}</p>
                      <p>
                        {d.date} —{' '}
                        {d.result === 'decay' ? 'inactivity decay' : `${d.result} vs ${d.opponent ?? 'unknown'}`}
                      </p>
                      <p className="num">
                        {d.rating.toFixed(0)} ± {d.rd.toFixed(0)}
                      </p>
                    </div>
                  );
                }}
              />
              {/* Band first so the line draws over it. */}
              <Area
                dataKey="band"
                stroke="none"
                fill="var(--series-1)"
                fillOpacity={0.16}
                isAnimationActive={false}
                name="±2 SD"
              />
              <Line
                type="monotone"
                dataKey="rating"
                stroke="var(--series-1)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                name="Skill"
              />
              {/* Decay is a different kind of event, so it gets its own mark. */}
              <Scatter dataKey="decayRating" fill="var(--warn)" shape="square" name="Inactivity decay" />
            </ComposedChart>
          </ResponsiveContainer>
        </section>
      )}

      <section className="section match-history">
        <h3>Match log ({matches.length} sets)</h3>
        {events.length === 0 ? (
          <p className="muted">No match history available for this player.</p>
        ) : (
          <div className="match-history-scroll">
            <table className="match-table data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Opponent</th>
                  <th>Result</th>
                  <th className="num">Δ Rating</th>
                </tr>
              </thead>
              <tbody>
                {tableEvents.map((event) => {
                  const ratingChange = event.postRating - event.preRating;
                  const rdChange = event.postRd - event.preRd;
                  return (
                    <tr key={event.seq} className={event.isDecay ? 'decay' : event.won ? 'win' : 'loss'}>
                      <td className="mono">{formatDate(event.tournamentDate)}</td>
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
                      <td className={`num ${ratingChange >= 0 ? 'rating-up' : 'rating-down'}`}>
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
      </section>
    </div>
  );
}
