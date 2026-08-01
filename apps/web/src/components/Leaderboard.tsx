import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { LeaderboardRow } from '../lib/apiTypes';
import { Sparkline } from './Sparkline';
import { CharacterIcons } from './CharacterIcons';
import { tierClass } from '../lib/format';
import './Leaderboard.css';

/**
 * The ranking board.
 *
 * Ranked on the club rating: the skill estimate, less a stated penalty for
 * missed club nights. Both halves are shown — the estimate with its ± band, and
 * the deduction as its own marker — because a member who drops places deserves
 * to see which of the two moved. The previous basis (skill less two standard
 * deviations) hid the attendance rule inside the error bar, so newcomers and
 * every-other-night regulars paid it too without anyone intending that.
 *
 * Each row carries the things a club member actually wants: where they sit, which
 * way they are moving over the last club night, recent form, how much the rating
 * can be trusted, and when they were last seen.
 */

export interface PlayerTrend {
  /** Conservative-of-skill trace for the sparkline, oldest first. */
  points: number[];
  /** Most recent results, oldest first; true = win. */
  form: boolean[];
}

interface Props {
  rows: LeaderboardRow[];
  trends: Map<string, PlayerTrend>;
}

type SortField = 'rank' | 'rating' | 'wins' | 'eventCount' | 'certainty' | 'lastSeen';

/**
 * The board's columns. Every sortable measure has its own column, so the header
 * row *is* the sort control — a separate button strip would name the same fields
 * twice. `field: null` marks a column that carries no orderable measure.
 */
const COLUMNS: { key: string; label: string; field: SortField | null; title?: string }[] = [
  { key: 'rank', label: '#', field: 'rank', title: 'Rank' },
  { key: 'movement', label: 'Δ', field: null, title: 'Places gained or lost over the last club night' },
  { key: 'identity', label: 'Player', field: null },
  {
    key: 'rating',
    label: 'Rating',
    field: 'rating',
    title: 'Club rating — the skill estimate less any penalty for missed club nights',
  },
  { key: 'certainty', label: 'Conf', field: 'certainty', title: 'How well established the rating is' },
  { key: 'form', label: 'Form', field: null, title: 'Last five sets, oldest first' },
  { key: 'spark', label: 'Trend', field: null, title: 'Recent rating trajectory' },
  { key: 'record', label: 'W–L', field: 'wins', title: 'Sets won and lost' },
  { key: 'events', label: 'Ev', field: 'eventCount', title: 'Events attended — a main and rookie bracket on one night count once' },
  { key: 'lastSeen', label: 'Seen', field: 'lastSeen', title: 'Which club night this player was last at' },
];

/**
 * How long ago someone was last at the club, in club nights rather than in days.
 *
 * Events are the unit the whole system counts in — the penalty is charged per
 * missed night, not per month — so a chip reading "2 missed" lines up with what
 * the rating did, where "5 months ago" would leave a member converting between
 * two different clocks to check the arithmetic.
 */
function lastSeenChip(row: LeaderboardRow): { text: string; className: string; title: string } {
  if (row.missedEvents === 0) {
    const streak = row.attendanceStreak;
    return {
      text: streak > 1 ? `${streak} in a row` : 'Latest',
      className: streak > 2 ? 'seen-streak' : 'seen-current',
      title:
        streak > 1
          ? `At the last ${streak} club nights in a row`
          : 'At the most recent club night',
    };
  }
  const missed = `${row.missedEvents} missed`;
  return {
    text: missed,
    className: row.activityPenalty > 0 ? 'seen-lapsed' : 'seen-away',
    title:
      row.activityPenalty > 0
        ? `Last seen ${row.lastPlayedDate}. ${row.missedEvents} club nights missed, costing ${Math.round(row.activityPenalty)} points.`
        : `Last seen ${row.lastPlayedDate}. Inside the grace window, so nothing has been docked.`,
  };
}

/**
 * Bar length encodes *confidence*, not doubt: a full bar means the rating is
 * well established, a stub means we have barely seen this player. Encoding it
 * the other way round reads backwards — a long bar looks like "more/better"
 * whatever the label says.
 *
 * 350 is the starting rating deviation, i.e. knowing nothing at all.
 */
function confidenceWidth(sd: number): number {
  return Math.max(4, Math.min(100, (1 - sd / 350) * 100));
}

export function Leaderboard({ rows, trends }: Props) {
  const [sortField, setSortField] = useState<SortField>('rank');
  const [descending, setDescending] = useState(false);
  const [companyFilter, setCompanyFilter] = useState('all');
  const [query, setQuery] = useState('');

  const companies = useMemo(
    () => [...new Set(rows.map((r) => r.companyCode).filter((c): c is string => Boolean(c)))].sort(),
    [rows],
  );

  const visible = useMemo(() => {
    let list = rows;
    if (companyFilter !== 'all') list = list.filter((r) => r.companyCode === companyFilter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q));

    const value = (row: LeaderboardRow): number => {
      switch (sortField) {
        case 'rank':
          return row.rank;
        case 'rating':
          return row.clubRating;
        case 'wins':
          return row.wins;
        case 'eventCount':
          return row.eventCount;
        case 'certainty':
          return -row.skillSd;
        case 'lastSeen':
          // Fewer missed nights sorts as "more recent".
          return -row.missedEvents;
      }
    };
    return [...list].sort((a, b) => (descending ? value(b) - value(a) : value(a) - value(b)));
  }, [rows, companyFilter, query, sortField, descending]);

  const sortBy = (field: SortField): void => {
    if (field === sortField) {
      setDescending(!descending);
    } else {
      setSortField(field);
      // Rank reads best ascending; every other measure reads best descending.
      setDescending(field !== 'rank');
    }
  };

  return (
    <section className="board">
      <div className="board-controls">
        <label className="control">
          <span className="control-label">Search</span>
          <input
            className="control-input"
            type="search"
            placeholder="Player name…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="control">
          <span className="control-label">Company</span>
          <select
            className="control-input"
            value={companyFilter}
            onChange={(event) => setCompanyFilter(event.target.value)}
          >
            <option value="all">All companies</option>
            {companies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <p className="board-count muted num">
          {visible.length}/{rows.length} players
        </p>
      </div>

      <div className="board-head" role="row">
        {COLUMNS.map((column) =>
          column.field === null ? (
            <span key={column.key} className={`head-cell head-${column.key}`} title={column.title}>
              {column.label}
            </span>
          ) : (
            <button
              key={column.key}
              type="button"
              className={`head-cell head-${column.key} head-sortable${
                sortField === column.field ? ' is-active' : ''
              }`}
              title={column.title}
              aria-sort={sortField === column.field ? (descending ? 'descending' : 'ascending') : 'none'}
              onClick={() => sortBy(column.field as SortField)}
            >
              {column.label}
              <span className="head-caret" aria-hidden="true">
                {sortField === column.field ? (descending ? '▾' : '▴') : ''}
              </span>
            </button>
          ),
        )}
      </div>

      <ol className="board-list">
        {visible.map((row) => {
          const trend = trends.get(row.playerId);
          const podium = sortField === 'rank' && !descending && row.rank <= 3;
          const seen = lastSeenChip(row);
          return (
            <li key={row.playerId} className={`board-row ${tierClass(row.league)}${podium ? ' is-podium' : ''}`}>
              <Link
                to="/players/$playerId"
                params={{ playerId: row.playerId }}
                className="board-link"
                aria-label={`${row.name}, rank ${row.rank}, rating ${Math.round(row.clubRating)}`}
              >
                <span className={`rank num${podium ? ` rank-${row.rank}` : ''}`}>{row.rank}</span>

                <span className="movement num" aria-hidden={row.rankDelta === null}>
                  {row.rankDelta === null || row.rankDelta === 0 ? (
                    <span className="movement-flat">–</span>
                  ) : row.rankDelta > 0 ? (
                    <span className="movement-up">▲{row.rankDelta}</span>
                  ) : (
                    <span className="movement-down">▼{Math.abs(row.rankDelta)}</span>
                  )}
                </span>

                <span className="identity">
                  <span className="identity-name">
                    {row.name}
                    {row.verified && (
                      <span className="verified" title="Claimed by its owner">
                        ✓
                      </span>
                    )}
                    {/* Says "we have barely seen this player" without pretending
                        that makes them weak — the number itself is already
                        shrunk toward the middle for exactly that reason. */}
                    {row.isProvisional && (
                      <span className="provisional" title="Provisional — too few sets for this rating to have settled">
                        P
                      </span>
                    )}
                  </span>
                  <span className="identity-meta">
                    {row.companyCode ?? 'IND'}
                    <CharacterIcons slugs={row.characters} />
                  </span>
                </span>

                <span className="rating">
                  <span className="rating-value num">{Math.round(row.clubRating)}</span>
                  {/* The estimate the ranked number is built from, so a member
                      can see which half moved: results move the estimate, missed
                      nights move the penalty beside it. */}
                  <span
                    className="rating-band num"
                    title={`Skill estimate ${Math.round(row.skillRating)} ± ${Math.round(row.skillSd)}`}
                  >
                    {Math.round(row.skillRating)}±{Math.round(row.skillSd)}
                  </span>
                  {row.activityPenalty > 0 && (
                    <span
                      className="rating-penalty num"
                      title={`${Math.round(row.activityPenalty)} points docked for ${row.missedEvents} missed club nights. Play once and it all comes back.`}
                    >
                      −{Math.round(row.activityPenalty)} away
                    </span>
                  )}
                </span>

                <span
                  className="certainty-track"
                  title={`Confidence ${Math.round(confidenceWidth(row.skillSd))}% — fuller means more sets against more opponents`}
                >
                  <span className="certainty-fill" style={{ width: `${confidenceWidth(row.skillSd)}%` }} />
                </span>

                <span className="form" aria-label={`Recent form: ${trend?.form.map((w) => (w ? 'win' : 'loss')).join(', ') || 'no results'}`}>
                  {(trend?.form ?? []).map((won, index) => (
                    <span key={index} className={`pip ${won ? 'pip-win' : 'pip-loss'}`} />
                  ))}
                </span>

                <span className="spark" aria-hidden="true">
                  {trend && trend.points.length > 1 ? <Sparkline points={trend.points} /> : null}
                </span>

                <span className="record num">
                  {row.wins}–{row.losses}
                </span>
                <span className="events num">{row.eventCount}</span>
                <span className={`last-seen ${seen.className}`} title={seen.title}>
                  {seen.text}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      {visible.length === 0 && (
        <p className="board-empty">
          No players match those filters. <button type="button" className="link-button" onClick={() => { setQuery(''); setCompanyFilter('all'); }}>Clear them</button>
        </p>
      )}
    </section>
  );
}
