import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import { timeAgo } from '../lib/format';
import { filterInactive } from '../lib/activity';
import { useNow } from '../lib/useNow';
import { useStoredFlag } from '../lib/useStoredFlag';
import { Leaderboard, type PlayerTrend } from '../components/Leaderboard';
import { RatingsOverTime } from '../components/RatingsOverTime';
import { InfoTip } from '../components/InfoTip';
import './LeaderboardPage.css';

/** How many recent results the form pips show. */
const FORM_LENGTH = 5;
/** How many rating points a sparkline traces. */
const SPARK_LENGTH = 12;
/**
 * How often the clock is re-read for the activity cutoff. The window is six
 * months wide, so nothing is lost by checking hourly — this exists only so a
 * page left open across a boundary eventually agrees with a reload.
 */
const ACTIVITY_TICK_MS = 60 * 60 * 1000;
/** Remembered across visits: every row is a link, so the board remounts often. */
const HIDE_INACTIVE_KEY = 'rankings.hideInactive';

export function LeaderboardPage() {
  const now = useNow(ACTIVITY_TICK_MS);
  const [hideInactive, setHideInactive] = useStoredFlag(HIDE_INACTIVE_KEY, true);

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
   * The field the screen is actually about. Hiding the long tail of players who
   * stopped coming is not just a display filter: rank and movement are
   * positions *within* a field, so both are re-derived over whoever is left
   * (see lib/activity). Everything below — the board, and the headline stats
   * that summarise it — reads from here rather than the raw response, so the
   * masthead can never describe a different set of players to the rows.
   */
  const board = useMemo(
    () => filterInactive(leaderboard.data?.rows ?? [], now, hideInactive),
    [leaderboard.data, now, hideInactive],
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

  const { computedAt, model, activityPolicy } = leaderboard.data;
  // Already filtered and re-ranked by the inactivity setting; see lib/activity.
  const rows = board.rows;

  /**
   * The attendance rule in one sentence, built from the settings actually in
   * force. Worth spending masthead space on: the point of moving the penalty out
   * of the error bar was that a member can now be told exactly what missing a
   * club night costs, and a rule nobody states is not really legible.
   */
  const policyLine = (() => {
    const { graceEvents, penaltyPerEvent, penaltyCap } = activityPolicy;
    const grace =
      graceEvents === 0
        ? 'Miss a club night'
        : graceEvents === 1
          ? 'Miss one club night and nothing happens; after that'
          : `Miss up to ${graceEvents} club nights and nothing happens; after that`;
    return `${grace} it is ${Math.round(penaltyPerEvent)} points a night, capped at ${Math.round(penaltyCap)}, and a single night back clears the lot.`;
  })();

  const summary = (() => {
    if (rows.length === 0) return null;
    const rated = rows.filter((r) => r.matchCount > 0);
    const sets = rated.reduce((sum, r) => sum + r.matchCount, 0) / 2;
    const median = [...rated].sort((a, b) => a.clubRating - b.clubRating)[Math.floor(rated.length / 2)];
    const climber = [...rows]
      .filter((r) => r.rankDelta !== null && r.rankDelta > 0)
      .sort((a, b) => (b.rankDelta ?? 0) - (a.rankDelta ?? 0))[0];
    /**
     * The longest active attendance run in the club. A carrot rather than a
     * lever: it changes nobody's rating, it just gives turning up regularly
     * something to point at, which in a casual club does more for attendance
     * than any amount of rating mechanics.
     */
    const streak = [...rows].sort((a, b) => b.attendanceStreak - a.attendanceStreak)[0];
    return {
      players: rated.length,
      sets: Math.round(sets),
      median,
      climber,
      streak: streak && streak.attendanceStreak >= 3 ? streak : null,
    };
  })();

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-headline">
          <p className="hero-eyebrow">{coverage}</p>
          <h1 className="hero-title">Rankings</h1>
          <p className="hero-sub muted">
            Ranked on your skill estimate, less a penalty for missed club nights. {policyLine} The smaller
            figure is the estimate and its ± band — play more and the band narrows.
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
              <dd className="num">{summary.median ? Math.round(summary.median.clubRating) : '—'}</dd>
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
            {summary.streak && (
              <div className="stat stat-streak">
                <dt>Longest streak</dt>
                <dd>
                  <span className="stat-climber-name">{summary.streak.name}</span>
                  <span className="stat-streak-count num"> {summary.streak.attendanceStreak} in a row</span>
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
          {/* Says so here as well as on the control, because the stats above
              count this field and would otherwise look simply wrong to anyone
              who knows how many people are in the club. */}
          {hideInactive && board.inactiveCount > 0 && ` · ${board.inactiveCount} inactive not counted`}
        </p>
      </header>

      {leaderboard.data.rows.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing ranked yet</h2>
          <p className="muted">
            Register a Challonge tournament in the admin area and sync it — ratings appear here once the first
            recompute finishes.
          </p>
        </div>
      ) : (
        <Leaderboard
          rows={rows}
          trends={trends}
          hideInactive={hideInactive}
          onHideInactiveChange={setHideInactive}
          inactiveCount={board.inactiveCount}
        />
      )}

      {ratingHistory.data && ratingHistory.data.players.length > 0 && (
        <RatingsOverTime history={ratingHistory.data} tournamentNames={tournamentNames} />
      )}
    </div>
  );
}
