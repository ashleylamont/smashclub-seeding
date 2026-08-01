import { useId, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { LeaderboardRow } from '../lib/apiTypes';
import { Sparkline } from './Sparkline';
import { CharacterIcons } from './CharacterIcons';
import { BoardLegend } from './BoardLegend';
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
  rows: LeaderboardRow[];
  trends: Map<string, PlayerTrend>;
}

type SortField = 'rank' | 'rating' | 'wins' | 'eventCount' | 'certainty';

/**
 * The board's columns. Every sortable measure has its own column, so the header
 * row *is* the sort control — a separate button strip would name the same fields
 * twice. `field: null` marks a column that carries no orderable measure.
 */
const COLUMNS: { key: string; label: string; field: SortField | null; name: string; title?: string }[] = [
  { key: 'rank', label: '#', field: 'rank', name: 'rank' },
  {
    key: 'movement',
    label: 'Δ',
    field: null,
    name: 'movement',
    title: 'Places gained or lost over the last club night',
  },
  { key: 'identity', label: 'Player', field: null, name: 'player' },
  {
    key: 'rating',
    label: 'Rating',
    field: 'rating',
    name: 'rating',
    title: 'Cautious rating — skill minus uncertainty, and what the board is ranked on',
  },
  {
    key: 'certainty',
    label: 'Conf',
    field: 'certainty',
    name: 'confidence',
    title: 'How well established the rating is',
  },
  { key: 'form', label: 'Form', field: null, name: 'form', title: 'Last five sets, oldest first' },
  { key: 'spark', label: 'Trend', field: null, name: 'trend', title: 'Recent rating trajectory' },
  { key: 'record', label: 'W–L', field: 'wins', name: 'sets won', title: 'Sets won and lost' },
  {
    key: 'events',
    label: 'Ev',
    field: 'eventCount',
    name: 'events attended',
    title: 'Events attended — a main and rookie bracket on one night count once',
  },
];

/**
 * The same measures, for the select that replaces the header row on a phone.
 * Below the fold-point the header is hidden — which used to mean the board
 * could not be sorted at all on the device most people read it on.
 */
const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: 'rank', label: 'Rank' },
  { field: 'rating', label: 'Rating' },
  { field: 'certainty', label: 'Confidence' },
  { field: 'wins', label: 'Sets won' },
  { field: 'eventCount', label: 'Events' },
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

/** "▲2" / "▼1" / "–" — the movement column, spelled out for a screen reader. */
function movementLabel(delta: number | null): string {
  if (delta === null) return 'no movement recorded';
  if (delta === 0) return 'unchanged';
  return delta > 0 ? `up ${delta}` : `down ${Math.abs(delta)}`;
}

/** The form pips, whose whole meaning is height and colour, as words. */
function formLabel(form: boolean[]): string {
  if (form.length === 0) return 'no results yet';
  return form.map((won) => (won ? 'win' : 'loss')).join(', ');
}

/**
 * The figure the board is currently ordered by, when the narrow layout does not
 * already draw it.
 *
 * The confidence meter and the event count are both dropped below the
 * fold-point, so sorting on either of them reordered the board into what looked
 * like no order at all — the same complaint the header row exists to answer.
 * Stating the sorted value in the row makes the order self-evident again.
 */
function sortKeyNote(row: LeaderboardRow, field: SortField): string | null {
  switch (field) {
    case 'certainty':
      return `${Math.round(confidenceWidth(row.skillSd))}% conf`;
    case 'eventCount':
      return `${row.eventCount} event${row.eventCount === 1 ? '' : 's'}`;
    default:
      // Rank, rating and record are all on the row already.
      return null;
  }
}

export function Leaderboard({ rows, trends }: Props) {
  const [sortField, setSortField] = useState<SortField>('rank');
  const [descending, setDescending] = useState(false);
  const [companyFilter, setCompanyFilter] = useState('all');
  const [query, setQuery] = useState('');
  const sortLabelId = useId();

  const companies = useMemo(
    () => [...new Set(rows.map((r) => r.companyCode).filter((c): c is string => Boolean(c)))].sort(),
    [rows],
  );

  const leagues = useMemo(() => [...new Set(rows.map((r) => r.league))], [rows]);

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

        {/* Hidden above the fold-point, where the header row already is the sort
            control and naming the measures twice would be the redundancy that
            header was chosen to avoid. */}
        <div className="control control-sort">
          <span className="control-label" id={sortLabelId}>
            Sort
          </span>
          <div className="sort-row">
            <select
              className="control-input"
              aria-labelledby={sortLabelId}
              value={sortField}
              onChange={(event) => sortBy(event.target.value as SortField)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.field} value={option.field}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-small sort-direction"
              aria-label={`Sorted ${descending ? 'highest first' : 'lowest first'}. Reverse the order.`}
              onClick={() => setDescending(!descending)}
            >
              <span aria-hidden="true">{descending ? '▾' : '▴'}</span>
            </button>
          </div>
        </div>

        <p className="board-count muted num">
          {visible.length}/{rows.length} players
        </p>
      </div>

      <BoardLegend leagues={leagues} />

      {/*
       * The header row carries the sort. These are toggle buttons rather than
       * table column headers — the board is a list of links, not a table — so
       * they say so with `aria-pressed`; `aria-sort` only means anything on a
       * real `columnheader`, and claiming a row role without a grid around it
       * describes a structure that is not there.
       */}
      <div className="board-head">
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
              aria-pressed={sortField === column.field}
              aria-label={
                sortField === column.field
                  ? `Sorted by ${column.name}, ${descending ? 'highest first' : 'lowest first'}. Reverse the order.`
                  : `Sort by ${column.name}`
              }
              onClick={() => sortBy(column.field as SortField)}
            >
              <span aria-hidden="true">{column.label}</span>
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
          const sortNote = sortKeyNote(row, sortField);
          return (
            <li key={row.playerId} className={`board-row ${tierClass(row.league)}${podium ? ' is-podium' : ''}`}>
              <Link
                to="/players/$playerId"
                params={{ playerId: row.playerId }}
                className="board-link"
                /*
                 * The link's label replaces everything inside it for a screen
                 * reader, so it has to carry the row: the marks that only exist
                 * as colour and height — movement and form — are spelled out
                 * here or they are not announced at all.
                 */
                aria-label={[
                  `${row.name}, rank ${row.rank}`,
                  `${row.league}`,
                  `rating ${Math.round(row.conservativeRating)}`,
                  movementLabel(row.rankDelta),
                  `${row.wins} won, ${row.losses} lost`,
                  `recent form ${formLabel(trend?.form ?? [])}`,
                ].join(', ')}
              >
                <span className={`rank num${podium ? ` rank-${row.rank}` : ''}`}>{row.rank}</span>

                <span className="movement num" aria-hidden="true">
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
                    {/* The league is on the row's left edge as colour. A phone
                        has no hover and the legend is a scroll away, so the
                        narrow layout names it here too. */}
                    <span className="identity-league">{row.league}</span>
                    {sortNote !== null && <span className="identity-sortkey">{sortNote}</span>}
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
                  aria-hidden="true"
                  title={`Confidence ${Math.round(confidenceWidth(row.skillSd))}% — fuller means more sets against more opponents`}
                >
                  <span className="certainty-fill" style={{ width: `${confidenceWidth(row.skillSd)}%` }} />
                </span>

                <span className="form" aria-hidden="true">
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
        </p>
      )}
    </section>
  );
}
