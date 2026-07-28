import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { LeaderboardRow } from '../lib/apiTypes';
import { leagueClass } from '../lib/format';
import './Leaderboard.css';

interface LeaderboardProps {
  rows: LeaderboardRow[];
}

type SortField = 'rank' | 'rating' | 'wins' | 'tournamentCount';
type SortDirection = 'asc' | 'desc';

export function Leaderboard({ rows }: LeaderboardProps) {
  const navigate = useNavigate();
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [nameFilter, setNameFilter] = useState('');

  const companies = useMemo(() => {
    const set = new Set(rows.map((r) => r.companyCode).filter((c): c is string => c != null));
    return Array.from(set).sort();
  }, [rows]);

  const filteredAndSorted = useMemo(() => {
    let filtered = rows;

    if (companyFilter !== 'all') {
      filtered = filtered.filter((r) => r.companyCode === companyFilter);
    }
    const query = nameFilter.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((r) => r.name.toLowerCase().includes(query));
    }

    return [...filtered].sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortField) {
        case 'rank':
          aVal = a.rank;
          bVal = b.rank;
          break;
        case 'rating':
          aVal = a.conservativeRating;
          bVal = b.conservativeRating;
          break;
        case 'wins':
          aVal = a.wins;
          bVal = b.wins;
          break;
        case 'tournamentCount':
          aVal = a.tournamentCount;
          bVal = b.tournamentCount;
          break;
      }
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }, [rows, sortField, sortDirection, companyFilter, nameFilter]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection(field === 'rank' ? 'asc' : 'desc');
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '⇅';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  return (
    <div className="leaderboard">
      <div className="filters">
        <label>
          Company
          <select className="select" value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
            <option value="all">All companies</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Player
          <input
            className="input"
            type="text"
            placeholder="Search by name…"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
          />
        </label>
      </div>

      <div className="table-scroll">
        <table className="rankings-table data-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('rank')}>Rank {getSortIcon('rank')}</th>
              <th>Player</th>
              <th>Company</th>
              <th>League</th>
              <th onClick={() => handleSort('rating')}>Con. Rating {getSortIcon('rating')}</th>
              <th title="Effective rating deviation (uncertainty)">RD</th>
              <th onClick={() => handleSort('wins')}>W-L {getSortIcon('wins')}</th>
              <th onClick={() => handleSort('tournamentCount')}>Events {getSortIcon('tournamentCount')}</th>
              <th title="Sample confidence: how reliable the rating is based on tournament count, unique opponents, total matches, and overlap between rookie/main brackets.">
                Confidence ℹ️
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredAndSorted.map((player) => (
              <tr
                key={player.playerId}
                className="player-row"
                onClick={() => void navigate({ to: '/players/$playerId', params: { playerId: player.playerId } })}
              >
                <td>{player.rank}</td>
                <td className="player-name">
                  {player.name}
                  {player.verified && (
                    <span className="verified-badge" title="Verified — claimed by their owner">
                      {' '}
                      ✓
                    </span>
                  )}
                </td>
                <td>{player.companyCode ?? '—'}</td>
                <td className="league-cell">
                  <span className={`league-badge ${leagueClass(player.league)}`}>{player.league}</span>
                </td>
                <td>{player.conservativeRating.toFixed(0)}</td>
                <td>{player.effectiveRd.toFixed(1)}</td>
                <td>
                  {player.wins}-{player.losses}
                </td>
                <td>{player.tournamentCount}</td>
                <td>{(player.sampleConfidence * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredAndSorted.length === 0 && <p className="muted no-rows">No players match the current filters.</p>}
    </div>
  );
}
