import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import { timeAgo } from '../lib/format';
import { Leaderboard, type PlayerTrend } from '../components/Leaderboard';
import { RatingsOverTime } from '../components/RatingsOverTime';
import { InfoTip } from '../components/InfoTip';
import './LeaderboardPage.css';

/** How many recent results the form pips show. */
const FORM_LENGTH = 5;
/** How many rating points a sparkline traces. */
const SPARK_LENGTH = 12;

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

  /**
   * The masthead eyebrow says what the ladder covers. The nav already carries the
   * club name, so repeating it here would spend the most prominent small line on
   * nothing.
   *
   * The event count comes from the server: a main and a rookie bracket on one
   * evening are one event, and that rule lives in the engine. Counting the
   * tournament rows here instead said "15 events" for ten occasions.
   */
  const coverage = useMemo(() => {
    const dates = (tournaments.data ?? [])
      .map((t) => t.eventDate)
      .filter((d): d is string => Boolean(d))
      .sort();
    const count = leaderboard.data?.eventCount ?? 0;
    const events = `${count} event${count === 1 ? '' : 's'}`;
    if (dates.length === 0) return events;
    const span = (iso: string) =>
      new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    const first = span(dates[0]!);
    const last = span(dates[dates.length - 1]!);
    return `${events} · ${first === last ? first : `${first} – ${last}`}`;
  }, [tournaments.data, leaderboard.data]);

  /**
   * Per-player sparkline traces and form pips, derived from the same rating
   * history the chart uses — one request serves both rather than adding a
   * per-row query.
   */
  const trends = useMemo(() => {
    const map = new Map<string, PlayerTrend>();
    for (const event of ratingHistory.data?.events ?? []) {
      const trend = map.get(event.playerId) ?? { points: [], form: [] };
      trend.points.push(event.postRating);
      if (!event.isDecay && event.won !== null) trend.form.push(event.won);
      map.set(event.playerId, trend);
    }
    for (const trend of map.values()) {
      trend.points = trend.points.slice(-SPARK_LENGTH);
      trend.form = trend.form.slice(-FORM_LENGTH);
    }
    return map;
  }, [ratingHistory.data]);

  if (leaderboard.isPending) {
    return (
      <div className="page">
        <div className="skeleton-hero" />
        <p className="loading-text">Loading rankings…</p>
      </div>
    );
  }
  if (leaderboard.isError) {
    return (
      <div className="page">
        <p className="error-text">Failed to load rankings: {leaderboard.error.message}</p>
        <p className="muted">
          The board is served by the club's own API — if this keeps happening the server is probably down rather
          than your connection.{' '}
          <button type="button" className="link-button" onClick={() => void leaderboard.refetch()}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  const { computedAt, rows, model } = leaderboard.data;

  const summary = (() => {
    if (rows.length === 0) return null;
    const rated = rows.filter((r) => r.matchCount > 0);
    const sets = rated.reduce((sum, r) => sum + r.matchCount, 0) / 2;
    const median = [...rated].sort((a, b) => a.conservativeRating - b.conservativeRating)[
      Math.floor(rated.length / 2)
    ];
    const climber = [...rows]
      .filter((r) => r.rankDelta !== null && r.rankDelta > 0)
      .sort((a, b) => (b.rankDelta ?? 0) - (a.rankDelta ?? 0))[0];
    return { players: rated.length, sets: Math.round(sets), median, climber };
  })();

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-headline">
          <p className="hero-eyebrow">{coverage}</p>
          <h1 className="hero-title">Rankings</h1>
          <p className="hero-sub muted">
            Ranked cautiously: your skill estimate less two standard deviations, so a rating has to be
            earned in sets and kept up by turning up. The smaller figure is that estimate and its ± band —
            play more and the gap between the two closes.
          </p>
        </div>

        {summary && (
          <dl className="hero-stats">
            <div className="stat">
              <dt>Players</dt>
              <dd className="num">{summary.players}</dd>
            </div>
            <div className="stat">
              <dt>Sets rated</dt>
              <dd className="num">{summary.sets}</dd>
            </div>
            <div className="stat">
              <dt>Median rating</dt>
              <dd className="num">{summary.median ? Math.round(summary.median.conservativeRating) : '—'}</dd>
            </div>
            {summary.climber && (
              <div className="stat stat-climber">
                <dt>Biggest climb</dt>
                <dd>
                  <span className="stat-climber-name">{summary.climber.name}</span>
                  <span className="stat-climber-delta num"> ▲{summary.climber.rankDelta}</span>
                </dd>
              </div>
            )}
          </dl>
        )}

        <p className="hero-meta muted">
          {computedAt ? `Updated ${timeAgo(computedAt)}` : 'No recompute yet'} · model <code>{model}</code>
          <InfoTip label="Rating model">
            Which rating system produced these numbers. Every recompute replays the club's whole set history
            through it, so ratings are derived from the results rather than adjusted after them — and switching
            model re-derives the entire board.
          </InfoTip>
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing ranked yet</h2>
          <p className="muted">
            Register a Challonge tournament in the admin area and sync it — ratings appear here once the first
            recompute finishes.
          </p>
        </div>
      ) : (
        <Leaderboard rows={rows} trends={trends} />
      )}

      {ratingHistory.data && ratingHistory.data.players.length > 0 && (
        <RatingsOverTime history={ratingHistory.data} tournamentNames={tournamentNames} />
      )}
    </div>
  );
}
