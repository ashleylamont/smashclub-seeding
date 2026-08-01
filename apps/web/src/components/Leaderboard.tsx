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
 * Ranked on the cautious rating — the skill estimate less two standard
 * deviations — so a place has to be earned in sets and held by turning up:
 * inactivity widens the deviation, and the club wants that to cost you. The
 * estimate and its ± band sit beside the ranked number so the subtraction is
 * legible rather than mysterious.
 *
 * Each row carries the things a club member actually wants: where they sit, which
 * way they are moving over the last club night, recent form, and how much the
 * rating can be trusted.
 */

export interface PlayerTrend {
  /** Conservative-of-skill trace for the sparkline, oldest first. */
  points: number[];
  /** Most recent results, oldest first; true = win. */
  form: boolean[];
}

interface Props {
  /** Already filtered and re-ranked by the page; see lib/activity. */
  rows: LeaderboardRow[];
  trends: Map<string, PlayerTrend>;
  /** Whether players with no event in the last year are excluded. */
  hideInactive: boolean;
  onHideInactiveChange: (next: boolean) => void;
  /** How many players the inactivity filter drops (or would drop). */
  inactiveCount: number;
}

type SortField = 'rank' | 'rating' | 'wins' | 'eventCount' | 'certainty';

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
    title: 'Cautious rating — skill minus uncertainty, and what the board is ranked on',
  },
  { key: 'certainty', label: 'Conf', field: 'certainty', title: 'How well established the rating is' },
  { key: 'form', label: 'Form', field: null, title: 'Last five sets, oldest first' },
  { key: 'spark', label: 'Trend', field: null, title: 'Recent rating trajectory' },
  { key: 'record', label: 'W–L', field: 'wins', title: 'Sets won and lost' },
  { key: 'events', label: 'Ev', field: 'eventCount', title: 'Events attended — a main and rookie bracket on one night count once' },
];

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

export function Leaderboard({ rows, trends, hideInactive, onHideInactiveChange, inactiveCount }: Props) {
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
          return row.conservativeRating;
        case 'wins':
          return row.wins;
        case 'eventCount':
          return row.eventCount;
        case 'certainty':
          return -row.skillSd;
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
        {/* Not a filter over the field so much as a definition of it: with it
            on, ranks and movement below are counted among these players only.
            On by default, because that is the field a member is asking about. */}
        <label className="control control-check">
          <span className="control-label">Activity</span>
          <span
            className="checkbox-control"
            title="Hides anyone with no event in the last year. Ranks and movement are counted among the players still shown, so an arrow never comes from someone ageing out."
          >
            <input
              type="checkbox"
              checked={hideInactive}
              onChange={(event) => onHideInactiveChange(event.target.checked)}
            />
            <span>Hide inactive</span>
          </span>
        </label>
        <p className="board-count muted num">
          {visible.length}/{rows.length} players
          {inactiveCount > 0 && (
            <span className="board-count-note">
              {hideInactive
                ? ` · ${inactiveCount} inactive hidden`
                : ` · ${inactiveCount} inactive shown`}
            </span>
          )}
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
          return (
            <li key={row.playerId} className={`board-row ${tierClass(row.league)}${podium ? ' is-podium' : ''}`}>
              <Link
                to="/players/$playerId"
                params={{ playerId: row.playerId }}
                className="board-link"
                aria-label={`${row.name}, rank ${row.rank}, rating ${Math.round(row.conservativeRating)}`}
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
                  </span>
                  <span className="identity-meta">
                    {row.companyCode ?? 'IND'}
                    <CharacterIcons slugs={row.characters} />
                  </span>
                </span>

                <span className="rating">
                  <span className="rating-value num">{Math.round(row.conservativeRating)}</span>
                  {/* The ranked number is the skill estimate less two standard
                      deviations, so the estimate itself is what the band is
                      drawn around — showing it keeps the subtraction visible
                      rather than making the rating look inexplicably low. */}
                  <span
                    className="rating-band num"
                    title={`Skill estimate ${Math.round(row.skillRating)} ± ${Math.round(row.skillSd)}; the rating subtracts two standard deviations`}
                  >
                    {Math.round(row.skillRating)}±{Math.round(row.skillSd)}
                  </span>
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
              </Link>
            </li>
          );
        })}
      </ol>

      {visible.length === 0 && (
        <p className="board-empty">
          No players match those filters. <button type="button" className="link-button" onClick={() => { setQuery(''); setCompanyFilter('all'); }}>Clear them</button>
          {/* Offered separately from "clear": the inactivity setting is on by
              default, so folding it into the same button would quietly undo a
              default the member never chose to change. */}
          {hideInactive && inactiveCount > 0 && (
            <>
              {' '}or{' '}
              <button type="button" className="link-button" onClick={() => onHideInactiveChange(false)}>
                include the {inactiveCount} inactive
              </button>
            </>
          )}
        </p>
      )}
    </section>
  );
}
