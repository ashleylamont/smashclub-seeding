import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RatingHistoryData } from '../lib/apiTypes';
import './RatingsOverTime.css';

interface RatingsOverTimeProps {
  history: RatingHistoryData;
  /** tournamentId -> display name (for x-axis labels). */
  tournamentNames: Map<string, string>;
}

// Perceptually distinct, contrast-safe color palette
const COLORS = [
  '#F3C300', '#875692', '#F38400', '#A1CAF1', '#BE0032',
  '#C2B280', '#848482', '#008856', '#E68FAC', '#0067A5',
  '#F99379', '#604E97', '#F6A600', '#B3446C', '#DCD300',
  '#882D17', '#8DB600', '#654522', '#E25822', '#2B3D26',
];

type Granularity = 'tournament' | 'event';
type YMode = 'rating' | 'floor';

interface Snapshot {
  label: string;
  index: number;
  [playerId: string]: string | number | null;
}

export function RatingsOverTime({ history, tournamentNames }: RatingsOverTimeProps) {
  const [granularity, setGranularity] = useState<Granularity>('tournament');
  const [showTopN, setShowTopN] = useState<number>(10);
  const [yMode, setYMode] = useState<YMode>('rating');
  const [searchFilter, setSearchFilter] = useState('');
  const [hiddenPlayers, setHiddenPlayers] = useState<Set<string>>(new Set());
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);

  const topPlayers = useMemo(() => {
    const query = searchFilter.trim().toLowerCase();
    const filtered = history.players.filter((p) => !query || p.name.toLowerCase().includes(query));
    return filtered.slice(0, showTopN);
  }, [history.players, showTopN, searchFilter]);

  const chartData = useMemo(() => {
    if (history.events.length === 0 || topPlayers.length === 0) return [];
    const selected = new Set(topPlayers.map((p) => p.playerId));
    const value = (rating: number, rd: number) => (yMode === 'floor' ? rating - 2 * rd : rating);

    const state = new Map<string, { rating: number; rd: number }>();
    const snapshots: Snapshot[] = [];

    const takeSnapshot = (label: string, index: number) => {
      const snapshot: Snapshot = { label, index };
      for (const player of topPlayers) {
        const s = state.get(player.playerId);
        snapshot[player.playerId] = s ? value(s.rating, s.rd) : null;
      }
      snapshots.push(snapshot);
    };

    if (granularity === 'tournament') {
      // Group events by tournament in first-appearance (seq) order.
      const byTournament = new Map<string, RatingHistoryData['events']>();
      for (const event of history.events) {
        const list = byTournament.get(event.tournamentId);
        if (list) list.push(event);
        else byTournament.set(event.tournamentId, [event]);
      }
      let index = 0;
      for (const [tournamentId, events] of byTournament) {
        for (const event of events) {
          state.set(event.playerId, { rating: event.postRating, rd: event.postRd });
        }
        const name = tournamentNames.get(tournamentId) ?? `Tournament ${index + 1}`;
        takeSnapshot(name.length > 30 ? name.substring(0, 27) + '…' : name, index);
        index += 1;
      }
    } else {
      // One snapshot per rating event that touches a charted player.
      for (const event of history.events) {
        state.set(event.playerId, { rating: event.postRating, rd: event.postRd });
        if (selected.has(event.playerId)) {
          takeSnapshot(`#${event.seq}`, event.seq);
        }
      }
    }
    return snapshots;
  }, [history.events, topPlayers, granularity, yMode, tournamentNames]);

  const nameById = useMemo(() => new Map(history.players.map((p) => [p.playerId, p.name])), [history.players]);

  if (history.events.length === 0) {
    return (
      <div className="ratings-over-time card">
        <h2>📈 Ratings Over Time</h2>
        <p className="no-data">No rating history yet — sync a tournament to get started.</p>
      </div>
    );
  }

  return (
    <div className="ratings-over-time card">
      <h2>📈 Ratings Over Time</h2>
      <div className="chart-controls">
        <label>
          Granularity
          <select className="select" value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)}>
            <option value="tournament">Per tournament</option>
            <option value="event">Per rating event</option>
          </select>
        </label>
        <label>
          Show top
          <select className="select" value={showTopN} onChange={(e) => setShowTopN(Number(e.target.value))}>
            <option value={5}>Top 5</option>
            <option value={10}>Top 10</option>
            <option value={15}>Top 15</option>
            <option value={20}>Top 20</option>
            <option value={999}>All</option>
          </select>
        </label>
        <label>
          Y-axis
          <select className="select" value={yMode} onChange={(e) => setYMode(e.target.value as YMode)}>
            <option value="rating">Rating</option>
            <option value="floor">Rating floor (rating − 2×RD)</option>
          </select>
        </label>
        <label>
          Filter players
          <input
            className="input"
            type="text"
            placeholder="Search by name…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
        </label>
      </div>

      <ResponsiveContainer width="100%" height={Math.max(480, 380 + topPlayers.length * 8)}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis
            dataKey="label"
            angle={granularity === 'tournament' ? -30 : 0}
            textAnchor={granularity === 'tournament' ? 'end' : 'middle'}
            height={granularity === 'tournament' ? 80 : 40}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            label={{
              value: yMode === 'floor' ? 'Rating floor (rating − 2×RD)' : 'Rating',
              angle: -90,
              position: 'insideLeft',
            }}
            allowDecimals={false}
            domain={['auto', 'auto']}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const sorted = [...payload]
                .filter((p) => p.value != null)
                .sort((a, b) => (b.value as number) - (a.value as number));
              return (
                <div className="custom-tooltip ratings-tooltip">
                  <p className="tooltip-label">
                    <strong>{label}</strong>
                  </p>
                  {sorted.map((entry, i) => (
                    <p key={i} style={{ color: entry.color, margin: '4px 0' }}>
                      <strong>{i + 1}.</strong> {nameById.get(entry.dataKey as string) ?? '?'}:{' '}
                      {(entry.value as number).toFixed(0)}
                    </p>
                  ))}
                </div>
              );
            }}
          />
          <Legend
            formatter={(value: string) => nameById.get(value) ?? value}
            onClick={(data) => {
              const key = data.dataKey as string;
              setHiddenPlayers((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            }}
            onMouseEnter={(data) => {
              const key = data.dataKey as string;
              if (!hiddenPlayers.has(key)) setHoveredPlayer(key);
            }}
            onMouseLeave={() => setHoveredPlayer(null)}
            wrapperStyle={{ cursor: 'pointer' }}
          />
          {topPlayers.map((player, i) => {
            const key = player.playerId;
            const isHidden = hiddenPlayers.has(key);
            const color = COLORS[i % COLORS.length];
            const isHovered = hoveredPlayer === key;
            const isOtherHovered = hoveredPlayer !== null && !isHovered;
            return (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={color}
                name={key}
                dot={granularity === 'tournament' ? { r: 4, fill: color, stroke: color } : false}
                activeDot={{ r: 6, fill: color, stroke: 'var(--bg)', strokeWidth: 2 }}
                connectNulls
                strokeWidth={isHovered ? 4 : 2.5}
                strokeOpacity={isHidden ? 0 : isOtherHovered ? 0.2 : 1}
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
