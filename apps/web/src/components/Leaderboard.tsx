import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { LeaderboardRow } from '../lib/apiTypes';
import { Sparkline } from './Sparkline';
import { tierClass } from '../lib/format';
import './Leaderboard.css';

/**
 * The ranking board.
 *
 * Ranked on best-estimate skill, with the uncertainty on that estimate shown
 * next to it rather than folded into the number — the previous design published
 * a single figure that mixed the two, so a busy mid-table player outranked a
 * strong infrequent one.
 *
 * Each row carries the things a club member actually wants: where they sit, which
 * way they are moving, recent form, and how much the rating can be trusted.
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

type SortField = 'rank' | 'skillRating' | 'wins' | 'tournamentCount' | 'certainty';

const SORT_LABELS: Record<SortField, string> = {
  rank: 'Rank',
  skillRating: 'Rating',
  wins: 'Wins',
  tournamentCount: 'Events',
  certainty: 'Certainty',
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]!}${parts[parts.length - 1]![0]!}`.toUpperCase();
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
        case 'skillRating':
          return row.skillRating;
        case 'wins':
          return row.wins;
        case 'tournamentCount':
          return row.tournamentCount;
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
        <div className="control control-sort">
          <span className="control-label">Sort by</span>
          <div className="sort-buttons" role="group" aria-label="Sort leaderboard">
            {(Object.keys(SORT_LABELS) as SortField[]).map((field) => (
              <button
                key={field}
                type="button"
                className={`sort-button${sortField === field ? ' is-active' : ''}`}
                aria-pressed={sortField === field}
                onClick={() => sortBy(field)}
              >
                {SORT_LABELS[field]}
                {sortField === field && <span aria-hidden="true">{descending ? ' ↓' : ' ↑'}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="board-count muted num">
        {visible.length} of {rows.length} players
      </p>

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
                aria-label={`${row.name}, rank ${row.rank}, rating ${Math.round(row.skillRating)}`}
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

                <span className="avatar" aria-hidden="true">
                  {initials(row.name)}
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
                  <span className="identity-meta muted">
                    {row.companyCode ?? 'Independent'} · {row.league}
                  </span>
                </span>

                <span className="rating">
                  <span className="rating-value num">{Math.round(row.skillRating)}</span>
                  <span className="rating-band num" title="Uncertainty on the estimate (± one standard deviation)">
                    ±{Math.round(row.skillSd)}
                  </span>
                  <span
                    className="certainty-track"
                    title={`Confidence: ${Math.round(confidenceWidth(row.skillSd))}% — a fuller bar means more sets played against more opponents`}
                  >
                    <span className="certainty-fill" style={{ width: `${confidenceWidth(row.skillSd)}%` }} />
                  </span>
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
                <span className="events num">{row.tournamentCount}</span>
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
