import { useState, useMemo } from 'react';
import type { PlayerRanking } from '../types';
import './Leaderboard.css';

interface LeaderboardProps {
  rankings: PlayerRanking[];
  onPlayerSelect: (player: PlayerRanking) => void;
}

type SortField = 'seed' | 'rating' | 'wins' | 'num_tournaments';
type SortDirection = 'asc' | 'desc';

export function Leaderboard({ rankings, onPlayerSelect }: LeaderboardProps) {
  const [sortField, setSortField] = useState<SortField>('seed');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [historyFilter, setHistoryFilter] = useState<'all' | 'has_history' | 'no_history'>('all');

  const companies = useMemo(() => {
    const set = new Set(rankings.map(r => r.company));
    return Array.from(set).sort();
  }, [rankings]);

  const filteredAndSorted = useMemo(() => {
    let filtered = rankings;

    if (companyFilter !== 'all') {
      filtered = filtered.filter(r => r.company === companyFilter);
    }

    if (historyFilter === 'has_history') {
      filtered = filtered.filter(r => r.has_history);
    } else if (historyFilter === 'no_history') {
      filtered = filtered.filter(r => !r.has_history);
    }

    const sorted = [...filtered].sort((a, b) => {
      let aVal: number, bVal: number;

      switch (sortField) {
        case 'seed':
          aVal = a.seed;
          bVal = b.seed;
          break;
        case 'rating':
          aVal = a.score.conservative_rating ?? -Infinity;
          bVal = b.score.conservative_rating ?? -Infinity;
          break;
        case 'wins':
          aVal = a.score.wins ?? 0;
          bVal = b.score.wins ?? 0;
          break;
        case 'num_tournaments':
          aVal = a.score.num_tournaments ?? 0;
          bVal = b.score.num_tournaments ?? 0;
          break;
        default:
          return 0;
      }

      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return sorted;
  }, [rankings, sortField, sortDirection, companyFilter, historyFilter]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
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
          Company:
          <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
            <option value="all">All Companies</option>
            {companies.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        <label>
          History:
          <select value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value as any)}>
            <option value="all">All Players</option>
            <option value="has_history">Has History</option>
            <option value="no_history">No History</option>
          </select>
        </label>
      </div>

      <table className="rankings-table">
        <thead>
          <tr>
            <th onClick={() => handleSort('seed')}>
              Seed {getSortIcon('seed')}
            </th>
            <th>Player</th>
            <th>Company</th>
            <th>League</th>
            <th onClick={() => handleSort('rating')}>
              Con. Rating {getSortIcon('rating')}
            </th>
            <th>RD</th>
            <th onClick={() => handleSort('wins')}>
              W-L {getSortIcon('wins')}
            </th>
            <th onClick={() => handleSort('num_tournaments')}>
              Events {getSortIcon('num_tournaments')}
            </th>
            <th title="Sample confidence: how reliable the rating is based on tournament count, unique opponents, total matches, and overlap between rookie/main brackets.">
              Confidence ℹ️
            </th>
          </tr>
        </thead>
        <tbody>
          {filteredAndSorted.map((player) => (
            <tr
              key={`${player.name}-${player.company}`}
              onClick={() => onPlayerSelect(player)}
              className="player-row"
            >
              <td>{player.seed}</td>
              <td className="player-name">{player.name}</td>
              <td>{player.company}</td>
              <td className="league-cell">
                {player.league ? (
                  <span className={`league-badge ${player.league.includes('Champions') ? 'champions' : player.league.includes('Full-Timers') ? 'smashclub' : player.league.includes('Grads') ? 'grads' : 'interns'}`}>
                    {player.league}
                  </span>
                ) : '-'}
              </td>
              <td>
                {player.score.conservative_rating != null 
                  ? player.score.conservative_rating.toFixed(0) 
                  : '-'}
              </td>
              <td>
                {player.score.rd != null 
                  ? player.score.rd.toFixed(1) 
                  : '-'}
              </td>
              <td>{player.score.wins}-{player.score.losses}</td>
              <td>{player.score.num_tournaments}</td>
              <td>
                {player.score.sample_confidence != null 
                  ? (player.score.sample_confidence * 100).toFixed(0) + '%' 
                  : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
