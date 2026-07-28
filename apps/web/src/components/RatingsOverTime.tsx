import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { MatchHistoryRow, PlayerRanking } from '../types';
import './RatingsOverTime.css';

interface RatingsOverTimeProps {
  matchHistory: MatchHistoryRow[];
  rankings: PlayerRanking[];
}

// Perceptually distinct, contrast-safe color palette
const COLORS = [
  '#F3C300', '#875692', '#F38400', '#A1CAF1', '#BE0032',
  '#C2B280', '#848482', '#008856', '#E68FAC', '#0067A5',
  '#F99379', '#604E97', '#F6A600', '#B3446C', '#DCD300',
  '#882D17', '#8DB600', '#654522', '#E25822', '#2B3D26',
];

type SnapshotMode = 'tournament' | 'match';
type YAxisMode = 'rating' | 'rank';

interface TournamentSnapshot {
  label: string;
  index: number;
  [playerKey: string]: string | number | null;
}

export function RatingsOverTime({ matchHistory, rankings }: RatingsOverTimeProps) {
  const [mode, setMode] = useState<SnapshotMode>('tournament');
  const [showTopN, setShowTopN] = useState<number>(10);
  const [yAxisMode, setYAxisMode] = useState<YAxisMode>('rating');
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [hiddenPlayers, setHiddenPlayers] = useState<Set<string>>(new Set());
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);

  // Get top N players by current seed, filtered by search
  const topPlayers = useMemo(() => {
    const filtered = rankings.filter(r => {
      if (!r.has_history) return false;
      if (!searchFilter) return true;
      return r.name.toLowerCase().includes(searchFilter.toLowerCase());
    });
    return filtered.slice(0, showTopN);
  }, [rankings, showTopN, searchFilter]);

  // Map ranking player keys to match history keys (name-based, company may differ)
  const playerKeyMap = useMemo(() => {
    const nameToMatchKeys = new Map<string, Set<string>>();
    for (const m of matchHistory) {
      if (!nameToMatchKeys.has(m.player_name)) {
        nameToMatchKeys.set(m.player_name, new Set());
      }
      nameToMatchKeys.get(m.player_name)!.add(`${m.player_name}|${m.company}`);
    }

    const mapping = new Map<string, string[]>();
    for (const p of topPlayers) {
      const rankingKey = `${p.name}|${p.company}`;
      const matchKeys = nameToMatchKeys.get(p.name);
      mapping.set(rankingKey, matchKeys ? Array.from(matchKeys) : []);
    }
    return mapping;
  }, [matchHistory, topPlayers]);

  // Build per-tournament snapshots
  const tournamentSnapshots = useMemo(() => {
    if (matchHistory.length === 0) return [];

    const tournamentMap = new Map<number, { name: string; date: string; matches: MatchHistoryRow[] }>();
    for (const m of matchHistory) {
      if (!tournamentMap.has(m.tournament_index)) {
        tournamentMap.set(m.tournament_index, { name: m.tournament, date: m.date, matches: [] });
      }
      tournamentMap.get(m.tournament_index)!.matches.push(m);
    }

    const sortedTournaments = Array.from(tournamentMap.entries())
      .sort(([a], [b]) => a - b);

    const playerState: Map<string, { rating: number; rd: number; processingIndex: number }> = new Map();
    const snapshots: TournamentSnapshot[] = [];
    const rankingKeys = topPlayers.map(p => `${p.name}|${p.company}`);

    for (const [tIdx, tournament] of sortedTournaments) {
      for (const m of tournament.matches) {
        const key = `${m.player_name}|${m.company}`;
        playerState.set(key, { rating: m.post_rating, rd: m.post_rd, processingIndex: m.processing_index });
      }

      const snapshot: TournamentSnapshot = {
        label: tournament.name.length > 30 
          ? tournament.name.substring(0, 27) + '...' 
          : tournament.name,
        index: tIdx,
      };

      for (const rKey of rankingKeys) {
        const playerName = rKey.split('|')[0]; // Just the name, ignore company
        let bestState: { rating: number; rd: number; processingIndex: number } | null = null;
        // Look for this player under any company variant, taking the latest processing_index
        for (const [key, state] of playerState) {
          if (key.split('|')[0] === playerName) {
            if (!bestState || state.processingIndex > bestState.processingIndex) {
              bestState = state;
            }
          }
        }
        if (bestState) {
          snapshot[rKey] = bestState.rating - 2 * bestState.rd;
        } else {
          snapshot[rKey] = null;
        }
      }

      snapshots.push(snapshot);
    }

    return snapshots;
  }, [matchHistory, topPlayers, playerKeyMap]);

  // Build per-match snapshots
  const matchSnapshots = useMemo(() => {
    if (matchHistory.length === 0 || mode !== 'match') return [];

    const sorted = [...matchHistory].sort((a, b) => a.processing_index - b.processing_index);
    const playerState: Map<string, { rating: number; rd: number; processingIndex: number }> = new Map();
    const rankingKeys = topPlayers.map(p => `${p.name}|${p.company}`);
    const snapshots: TournamentSnapshot[] = [];

    let lastIdx = -1;

    for (const m of sorted) {
      const key = `${m.player_name}|${m.company}`;
      playerState.set(key, { rating: m.post_rating, rd: m.post_rd, processingIndex: m.processing_index });

      if (m.processing_index !== lastIdx) {
        lastIdx = m.processing_index;

        const snapshot: TournamentSnapshot = {
          label: `Match ${m.processing_index}`,
          index: m.processing_index,
        };

        for (const rKey of rankingKeys) {
          const playerName = rKey.split('|')[0]; // Just the name, ignore company
          let bestState: { rating: number; rd: number; processingIndex: number } | null = null;
          // Look for this player under any company variant, taking the latest processing_index
          for (const [key, state] of playerState) {
            if (key.split('|')[0] === playerName) {
              if (!bestState || state.processingIndex > bestState.processingIndex) {
                bestState = state;
              }
            }
          }
          if (bestState) {
            snapshot[rKey] = bestState.rating - 2 * bestState.rd;
          } else {
            snapshot[rKey] = null;
          }
        }

        snapshots.push(snapshot);
      }
    }

    return snapshots;
  }, [matchHistory, topPlayers, mode, playerKeyMap]);

  const ratingData = mode === 'tournament' ? tournamentSnapshots : matchSnapshots;

  // Convert rating snapshots to ordinal rank snapshots
  const rankData = useMemo(() => {
    if (yAxisMode !== 'rank') return [];

    const rankingKeys = topPlayers.map(p => `${p.name}|${p.company}`);

    return ratingData.map(snapshot => {
      const playersWithRatings: { key: string; rating: number }[] = [];
      for (const key of rankingKeys) {
        const val = snapshot[key];
        if (val != null && typeof val === 'number') {
          playersWithRatings.push({ key, rating: val });
        }
      }

      playersWithRatings.sort((a, b) => b.rating - a.rating);

      const rankSnapshot: TournamentSnapshot = {
        label: snapshot.label,
        index: snapshot.index,
      };

      for (const key of rankingKeys) {
        const rankIdx = playersWithRatings.findIndex(p => p.key === key);
        rankSnapshot[key] = rankIdx >= 0 ? rankIdx + 1 : null;
      }

      return rankSnapshot;
    });
  }, [ratingData, topPlayers, yAxisMode]);

  const chartData = yAxisMode === 'rank' ? rankData : ratingData;

  if (matchHistory.length === 0) {
    return (
      <div className="ratings-over-time">
        <h2>📈 Ratings Over Time</h2>
        <p className="no-data">No match history data available. Make sure glicko_match_history.csv is exported.</p>
      </div>
    );
  }

  return (
    <div className="ratings-over-time">
      <h2>📈 Ratings Over Time</h2>
      <div className="chart-controls">
        <label>
          Granularity:
          <select value={mode} onChange={(e) => setMode(e.target.value as SnapshotMode)}>
            <option value="tournament">Per Tournament</option>
            <option value="match">Per Match</option>
          </select>
        </label>
        <label>
          Show Top:
          <select value={showTopN} onChange={(e) => setShowTopN(Number(e.target.value))}>
            <option value={5}>Top 5</option>
            <option value={10}>Top 10</option>
            <option value={15}>Top 15</option>
            <option value={20}>Top 20</option>
            <option value={999}>All</option>
          </select>
        </label>
        <label>
          Y-Axis:
          <select value={yAxisMode} onChange={(e) => setYAxisMode(e.target.value as YAxisMode)}>
            <option value="rating">Conservative Rating</option>
            <option value="rank">Ordinal Rank</option>
          </select>
        </label>
        <label>
          Filter Players:
          <input
            type="text"
            placeholder="Search by name..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
        </label>
      </div>

      <ResponsiveContainer width="100%" height={Math.max(500, 400 + topPlayers.length * 8)}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            angle={mode === 'tournament' ? -30 : 0}
            textAnchor={mode === 'tournament' ? 'end' : 'middle'}
            height={mode === 'tournament' ? 80 : 40}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            label={{ value: yAxisMode === 'rank' ? 'Rank' : 'Conservative Rating', angle: -90, position: 'insideLeft' }}
            reversed={yAxisMode === 'rank'}
            allowDecimals={false}
            domain={yAxisMode === 'rank' ? [1, 'auto'] : ['auto', 'auto']}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;

              const sorted = [...payload]
                .filter(p => p.value != null)
                .sort((a, b) => {
                  const aVal = a.value as number;
                  const bVal = b.value as number;
                  return yAxisMode === 'rank' ? aVal - bVal : bVal - aVal;
                });

              return (
                <div className="custom-tooltip ratings-tooltip">
                  <p className="tooltip-label"><strong>{label}</strong></p>
                  {sorted.map((entry, i) => (
                    <p key={i} style={{ color: entry.color, margin: '4px 0' }}>
                      <strong>{yAxisMode === 'rank' ? `#${entry.value}` : `${i + 1}.`}</strong>{' '}
                      {(entry.dataKey as string).split('|')[0]}
                      {yAxisMode === 'rating' ? `: ${(entry.value as number).toFixed(0)}` : ''}
                    </p>
                  ))}
                </div>
              );
            }}
          />
          <Legend
            formatter={(value: string) => value.split('|')[0]}
            onClick={(data) => {
              const key = data.dataKey as string;
              setHiddenPlayers(prev => {
                const next = new Set(prev);
                if (next.has(key)) {
                  next.delete(key);
                } else {
                  next.add(key);
                }
                return next;
              });
            }}
            onMouseEnter={(data) => {
              const key = data.dataKey as string;
              if (!hiddenPlayers.has(key)) {
                setHoveredPlayer(key);
              }
            }}
            onMouseLeave={() => {
              setHoveredPlayer(null);
            }}
            wrapperStyle={{ cursor: 'pointer' }}
          />
          {topPlayers.map((player, i) => {
            const key = `${player.name}|${player.company}`;
            const isHidden = hiddenPlayers.has(key);
            const color = COLORS[i % COLORS.length];
            const isHovered = hoveredPlayer === key;
            const isOtherHovered = hoveredPlayer !== null && !isHovered;
            
            // Highlight on hover: make hovered line bold, dim others
            // Hidden lines are invisible but still in legend
            const strokeWidth = isHovered ? 4 : 2.5;
            const strokeOpacity = isHidden ? 0 : (isOtherHovered ? 0.2 : 1);
            
            return (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={color}
                name={key}
                dot={mode === 'tournament' ? { r: 4, fill: color, stroke: color } : false}
                activeDot={{ r: 6, fill: color, stroke: 'white', strokeWidth: 2 }}
                connectNulls
                strokeWidth={strokeWidth}
                strokeOpacity={strokeOpacity}
                strokeDasharray={i % 4 === 0 ? '0' : i % 4 === 1 ? '5 5' : i % 4 === 2 ? '10 5' : '2 4'}
                hide={isHidden}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
