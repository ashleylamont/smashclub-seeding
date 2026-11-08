import { Select, SelectItem } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { trpc } from '../lib/trpc';
import type { PlayerData, PlayerEventView } from '../lib/apiTypes';
import { CharacterIcons } from '../components/CharacterIcons';
import { PlayerRatingNight } from '../components/PlayerRatingNight';
import { WhrResultImpact } from '../components/WhrResultImpact';
import { InfoTip } from '../components/InfoTip';
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
  if (query.isError)
    return <p className="error-text">Failed to load player: {query.error.message}</p>;
  if (query.data === null) return <p className="error-text">Player not found.</p>;
  if (redirectTo) return <p className="loading-text">Redirecting…</p>;

  return <PlayerProfile data={query.data as PlayerData} />;
}

function PlayerProfile({ data }: { data: PlayerData }) {
  const { player, rating, nights, recomputeId } = data;
  const [impactSetId, setImpactSetId] = useState<string | null>(null);
  // The server types these rows loosely (Record<string, unknown>); see PlayerEventView.
  const events = data.events as unknown as PlayerEventView[];
  const chartData = useMemo(() => {
    const attendedNights = new Map<string, PlayerEventView>();
    for (const event of events)
      attendedNights.set(event.tournamentDate?.slice(0, 10) ?? event.tournamentId, event);
    const points = nights?.length
      ? nights.map((night) => ({
          ...night,
          date: `${night.eventKey}T12:00:00Z`,
          tournament: attendedNights.get(night.eventKey)?.tournamentName ?? 'Club night',
        }))
      : [...attendedNights.values()].map((event) => ({
          ...event,
          date: event.tournamentDate,
          tournament: event.tournamentName,
          played: true,
        }));
    return points.map((point, idx) => ({
      idx: idx + 1,
      tournament: point.tournament,
      date: formatDate(point.date),
      played: point.played,
      rating: point.postRating,
      band: [point.postRating - 2 * point.postRd, point.postRating + 2 * point.postRd] as [
        number,
        number,
      ],
      rd: point.postRd,
      revised: point.revisedRating,
    }));
  }, [events, nights]);

  /**
   * Only draw the hindsight series when it actually disagrees somewhere —
   * right after a recompute of a fresh night the two coincide, and a dashed
   * line perfectly under the solid one is noise.
   */
  const showRevised = useMemo(
    () =>
      chartData.some(
        (point) => point.revised !== null && Math.abs(point.revised - point.rating) >= 1,
      ),
    [chartData],
  );

  const matches = useMemo(() => events.filter((e) => !e.isDecay), [events]);
  const [stageFilter, setStageFilter] = useState<'all' | 'group' | 'final'>('all');
  const hasBothStages = useMemo(
    () =>
      new Set(
        matches
          .map((event) => event.resultStage)
          .filter((stage): stage is 'group' | 'final' => stage !== null),
      ).size > 1,
    [matches],
  );
  const effectiveStage = hasBothStages ? stageFilter : 'all';
  const wins = matches.filter((e) => e.won).length;
  const winRate = matches.length > 0 ? ((wins / matches.length) * 100).toFixed(0) : null;

  const confidenceExplainer = useMemo(() => {
    if (!rating) return 'No rated match history yet.';
    const parts: string[] = [
      `${rating.tournamentCount} bracket(s), ${rating.uniqueOpponentCount} unique opponent(s), ${rating.matchCount} set(s).`,
    ];
    if (rating.rookieRatio > 0) {
      parts.push(`${(rating.rookieRatio * 100).toFixed(0)}% of sets in rookie brackets.`);
      parts.push('Where the rookie and main pools barely overlap, uncertainty stays wider.');
    }
    if (rating.missedEvents > 0) {
      parts.push('Confidence fades during time away until results firm it up again.');
    }
    return parts.join(' ');
  }, [rating]);

  // Most recent first for the table.
  const tableEvents = useMemo(
    () =>
      [...events]
        .reverse()
        .filter((event) => effectiveStage === 'all' || event.resultStage === effectiveStage),
    [events, effectiveStage],
  );

  /**
   * Where this player stands with the attendance policy, and — the part worth
   * having — what the next club night is worth to them either way.
   *
   * Under the old design this question had no answer anyone could give: the cost
   * of missing a night was an emergent function of the player's volatility,
   * their current RD, how many nights they had already missed and where the cap
   * fell. Stating the penalty outright makes it a subtraction, so it can simply
   * be shown before the decision rather than explained after it.
   */
  const activity = useMemo(() => {
    if (!rating) return null;
    const { missedEvents, attendanceStreak, activityPenalty, nextMissPenalty } = rating;
    const standing =
      missedEvents === 0
        ? attendanceStreak > 1
          ? `At the last ${attendanceStreak} club nights in a row.`
          : 'At the most recent club night.'
        : `${missedEvents} club night${missedEvents === 1 ? '' : 's'} missed since ${formatDate(rating.lastPlayedDate)}.`;

    const now =
      activityPenalty > 0
        ? `${activityPenalty.toFixed(0)} points are currently docked. Playing once puts all of them back.`
        : missedEvents > 0
          ? 'Still inside the grace window, so nothing is docked yet.'
          : 'Nothing docked.';

    const next =
      nextMissPenalty > 0
        ? `Missing the next one would cost ${nextMissPenalty.toFixed(0)}${activityPenalty > 0 ? ' more' : ''}.`
        : activityPenalty > 0
          ? 'Missing the next one costs nothing further — the penalty is already at its cap.'
          : 'Missing the next one would still cost nothing.';

    /**
     * The tile's headline. Deliberately never "−0": inside the grace window
     * nothing has been docked, and showing a zero deduction reads as a penalty
     * that happens to round to nothing rather than as no penalty at all.
     */
    const headline =
      activityPenalty > 0
        ? `−${activityPenalty.toFixed(0)}`
        : missedEvents > 0
          ? `${missedEvents} missed`
          : attendanceStreak > 1
            ? `${attendanceStreak} in a row`
            : 'Up to date';

    return { headline, standing, now, next, penalised: activityPenalty > 0 };
  }, [rating]);

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
          {player.characters.length > 0 && (
            <div className="profile-characters">
              <CharacterIcons slugs={player.characters} size="lg" />
            </div>
          )}
        </div>

        {/* The headline figure is the ranked number — the club rating — because
            a profile that led with a figure the board does not rank on just
            looks like the board is wrong. The skill estimate it is built from
            sits below it, and the deduction, if any, beside that. */}
        {rating && (
          <div className="profile-headline">
            <span className="headline-label">
              Rating
              <InfoTip label="Rating" align="end">
                The board ranks on this: the skill estimate below, less a penalty for missed club
                nights. Results move the estimate; turning up — or not — moves the penalty. Bracket
                seeding uses a different, more cautious number, so a seed and a rank need not agree.
              </InfoTip>
            </span>
            <span className="headline-value num">{rating.clubRating.toFixed(0)}</span>
            <span className="headline-band num">
              skill {rating.skillRating.toFixed(0)} ± {rating.skillSd.toFixed(0)}
              {rating.activityPenalty > 0 && (
                <span className="headline-penalty">
                  {' '}
                  · −{rating.activityPenalty.toFixed(0)} away
                </span>
              )}
            </span>
          </div>
        )}
      </header>

      <dl className="profile-stats">
        <div className="stat">
          <dt>Skill estimate</dt>
          <dd className="num">{rating ? rating.skillRating.toFixed(0) : '—'}</dd>
          <dd className="stat-detail">
            Best guess at how good you are, from results alone. The rating above is this number less
            any penalty for missed club nights — with none owing, the two are the same.
          </dd>
        </div>
        <div className="stat">
          <dt>Record</dt>
          <dd className="num">
            {rating ? `${rating.wins}–${rating.losses}` : `${wins}–${matches.length - wins}`}
          </dd>
          <dd className="stat-detail">
            {winRate != null ? `${winRate}% of sets won` : 'No sets played'}
          </dd>
        </div>
        <div className="stat">
          <dt>Events</dt>
          <dd className="num">{rating ? rating.eventCount : '—'}</dd>
          <dd className="stat-detail">
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
          </dd>
        </div>
        <div className="stat">
          <dt>Confidence</dt>
          <dd className="num">{rating ? `${(rating.sampleConfidence * 100).toFixed(0)}%` : '—'}</dd>
          <dd className="stat-detail">{confidenceExplainer}</dd>
        </div>
        {activity && (
          <div className={`stat${activity.penalised ? ' stat-penalised' : ''}`}>
            <dt>Attendance</dt>
            <dd className="num">{activity.headline}</dd>
            <dd className="stat-detail">
              {activity.standing} {activity.now} {activity.next}
            </dd>
          </div>
        )}
      </dl>

      {rating?.isProvisional && (
        <p className="banner banner-info provisional-note">
          Provisional — too few sets so far for this rating to have settled, so it is held near the
          middle of the field rather than swinging on a handful of results. It firms up as the sets
          come in.
        </p>
      )}

      {nights?.length > 0 && <PlayerRatingNight key={player.id} nights={nights} />}

      {chartData.length > 0 && (
        <section className="section rating-chart">
          <h3>Rating history</h3>
          <p className="muted chart-caption">
            {nights?.length
              ? 'WHR estimates include club nights the player missed.'
              : 'WHR estimate after each played club night.'}{' '}
            The shaded band is ±2 standard deviations.
            {showRevised && ' The dashed line shows the current fit’s revised historical estimate.'}
          </p>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
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
                        {d.date}
                        {!d.played && ' · No rated sets'}
                      </p>
                      <p className="num">
                        {d.rating.toFixed(0)} ± {d.rd.toFixed(0)}
                      </p>
                      {showRevised && d.revised !== null && Math.abs(d.revised - d.rating) >= 1 && (
                        <p className="num">now revised to {d.revised.toFixed(0)}</p>
                      )}
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
                name="Night estimate"
              />
              {/* Hindsight: what the current fit says this player's skill was
                  on each night, given everything played since. Dashed and
                  alongside the prefix estimate. */}
              {showRevised && (
                <Line
                  type="monotone"
                  dataKey="revised"
                  stroke="var(--series-2)"
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  dot={false}
                  isAnimationActive={false}
                  name="Hindsight"
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </section>
      )}

      {data.doublesResults?.length > 0 && (
        <section className="section">
          <h2>Doubles results</h2>
          <p className="muted">Team results are recorded separately from singles ratings.</p>
          <ul>
            {data.doublesResults.map((r) => (
              <li key={r.tournamentId}>
                <Link to="/events/$slug" params={{ slug: r.slug }}>
                  {r.name}
                </Link>{' '}
                · {r.pairName} · {r.place ? `Place ${r.place}` : 'Unplaced'}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="section match-history">
        <h3>
          Match log (
          {effectiveStage === 'all'
            ? matches.length
            : `${tableEvents.filter((event) => !event.isDecay).length} of ${matches.length}`}{' '}
          sets)
        </h3>
        {hasBothStages && (
          <label className="history-stage-filter">
            <span>Show</span>
            <Select
              aria-label="Filter match history by stage"
              value={stageFilter}
              onValueChange={(selectedValue) => setStageFilter(selectedValue as typeof stageFilter)}
            >
              <SelectItem value="all">All stages</SelectItem>
              <SelectItem value="group">Pools</SelectItem>
              <SelectItem value="final">Bracket</SelectItem>
            </Select>
          </label>
        )}
        {events.length > 0 && (
          <p className="muted chart-caption">
            {recomputeId
              ? 'WHR fits whole nights. Open WHR impact to see how one set affected that night’s estimate.'
              : 'WHR fits whole nights. Individual sets have no exact rating delta.'}
          </p>
        )}
        {events.length === 0 ? (
          <p className="muted">No match history available for this player.</p>
        ) : (
          <div
            className="match-history-scroll table-scroll"
            role="region"
            aria-label="Match results"
            tabIndex={0}
          >
            <table className="match-table data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Stage</th>
                  <th>Opponent</th>
                  <th>Result</th>
                  <th
                    className="num"
                    title="Evidence strength in the WHR fit; not a points multiplier"
                  >
                    Evidence
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableEvents.map((event) => {
                  return (
                    <tr
                      key={event.seq}
                      className={event.isDecay ? 'decay' : event.won ? 'win' : 'loss'}
                    >
                      <td className="mono">{formatDate(event.tournamentDate)}</td>
                      <td>
                        {event.tournamentName}
                        {event.isRookie && (
                          <span className="chip chip-warning rookie-chip">rookie</span>
                        )}
                        {recomputeId && event.setId && !event.isDecay && event.won != null && (
                          <div className="whr-impact-action">
                            <Button
                              size="small"
                              aria-label={`WHR impact for ${event.tournamentName} against ${event.opponentName ?? 'this opponent'}`}
                              onClick={(e) => {
                                e.currentTarget.focus();
                                setImpactSetId(event.setId);
                              }}
                            >
                              WHR impact
                            </Button>
                          </div>
                        )}
                      </td>
                      <td>
                        {event.isDecay ? '—' : event.resultStage === 'group' ? 'Pool' : 'Bracket'}
                      </td>
                      <td>
                        {event.isDecay ? (
                          <em>Inactivity decay</em>
                        ) : event.opponentPlayerId ? (
                          <Link
                            to="/players/$playerId"
                            params={{ playerId: event.opponentPlayerId }}
                          >
                            {event.opponentName ?? 'Unknown'}
                          </Link>
                        ) : (
                          (event.opponentName ?? 'Unknown')
                        )}
                      </td>
                      <td
                        className={
                          event.isDecay ? 'result-decay' : event.won ? 'result-win' : 'result-loss'
                        }
                      >
                        {event.isDecay ? '—' : event.won ? 'W' : 'L'}
                      </td>
                      <td className="num">
                        {event.weight == null ? '—' : `×${event.weight.toFixed(1)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {recomputeId && impactSetId && (
        <WhrResultImpact
          playerId={player.id}
          setId={impactSetId}
          recomputeId={recomputeId}
          onClose={() => setImpactSetId(null)}
        />
      )}
    </div>
  );
}
