import { useCallback, useMemo, useState } from 'react';
import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RatingHistoryData } from '../lib/apiTypes';
import './RatingsOverTime.css';

interface RatingsOverTimeProps {
  history: RatingHistoryData;
  /** tournamentId -> display name (for x-axis labels). */
  tournamentNames: Map<string, string>;
}

/**
 * Head-to-head trajectories.
 *
 * This is a *comparison* chart, not a chart of everyone: a line per player only
 * reads while there are few enough lines to tell apart. The previous version
 * cycled a 20-hue palette by rank index, which meant (a) hues repeated once past
 * the end of the list, and (b) removing a player repainted everyone below them.
 *
 * So: an explicit selection capped at the palette size, and a colour slot that
 * belongs to the *player* for as long as they are selected. Dropping one player
 * leaves every other line exactly the colour it was.
 */

/** The validated categorical palette, in fixed order. Never cycled. */
const SERIES_SLOTS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
];

/** Secondary encoding, so identity survives colour-blindness and print. */
const SERIES_DASH = ['0', '6 4', '2 3', '10 4', '1 3', '8 3 2 3', '4 2', '12 5'];

const MAX_SERIES = SERIES_SLOTS.length;

/** How many players are pre-selected on first render. */
const DEFAULT_SELECTION = 5;

type Granularity = 'tournament' | 'event';
type YMode = 'rating' | 'cautious';

interface Snapshot {
  label: string;
  index: number;
  [playerId: string]: string | number | null;
}

export function RatingsOverTime({ history, tournamentNames }: RatingsOverTimeProps) {
  const [granularity, setGranularity] = useState<Granularity>('tournament');
  const [yMode, setYMode] = useState<YMode>('rating');
  const [search, setSearch] = useState('');

  /**
   * playerId -> colour slot. The array position *is* the slot, so a player
   * keeps their colour until they are removed, and a freed slot is reused by
   * whoever is added next.
   */
  const [slots, setSlots] = useState<(string | null)[]>(() => {
    const initial: (string | null)[] = Array.from({ length: MAX_SERIES }, () => null);
    history.players.slice(0, DEFAULT_SELECTION).forEach((player, i) => {
      initial[i] = player.playerId;
    });
    return initial;
  });

  const selected = useMemo(
    () =>
      slots
        .map((playerId, slot) => (playerId ? { playerId, slot } : null))
        .filter((entry): entry is { playerId: string; slot: number } => entry !== null),
    [slots],
  );
  const selectedIds = useMemo(() => new Set(selected.map((s) => s.playerId)), [selected]);
  const full = selected.length >= MAX_SERIES;

  const toggle = useCallback((playerId: string) => {
    setSlots((prev) => {
      const at = prev.indexOf(playerId);
      if (at !== -1) {
        const next = [...prev];
        next[at] = null;
        return next;
      }
      const free = prev.indexOf(null);
      if (free === -1) return prev; // At capacity — the UI disables this case.
      const next = [...prev];
      next[free] = playerId;
      return next;
    });
  }, []);

  const nameById = useMemo(() => new Map(history.players.map((p) => [p.playerId, p.name])), [history.players]);

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return history.players.filter((p) => p.name.toLowerCase().includes(query)).slice(0, 8);
  }, [history.players, search]);

  const chartData = useMemo(() => {
    if (history.events.length === 0 || selected.length === 0) return [];
    const value = (rating: number, rd: number) => (yMode === 'cautious' ? rating - 2 * rd : rating);

    const state = new Map<string, { rating: number; rd: number }>();
    const snapshots: Snapshot[] = [];

    const takeSnapshot = (label: string, index: number) => {
      const snapshot: Snapshot = { label, index };
      for (const { playerId } of selected) {
        const s = state.get(playerId);
        snapshot[playerId] = s ? value(s.rating, s.rd) : null;
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
        const name = tournamentNames.get(tournamentId) ?? `Event ${index + 1}`;
        takeSnapshot(name.length > 24 ? name.slice(0, 21) + '…' : name, index);
        index += 1;
      }
    } else {
      // One snapshot per rating event that touches a charted player.
      for (const event of history.events) {
        state.set(event.playerId, { rating: event.postRating, rd: event.postRd });
        if (selectedIds.has(event.playerId)) takeSnapshot(`#${event.seq}`, event.seq);
      }
    }
    return snapshots;
  }, [history.events, selected, selectedIds, granularity, yMode, tournamentNames]);

  /** Last snapshot index at which each series has a value, for direct labels. */
  const lastIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    chartData.forEach((snapshot, i) => {
      for (const { playerId } of selected) {
        if (snapshot[playerId] != null) map.set(playerId, i);
      }
    });
    return map;
  }, [chartData, selected]);

  /** Direct labels only while few enough lines that names will not collide. */
  const directLabels = selected.length <= 4;

  if (history.events.length === 0) {
    return (
      <section className="ratings-over-time section">
        <h2>Ratings over time</h2>
        <p className="no-data">No rating history yet — sync a tournament to get started.</p>
      </section>
    );
  }

  return (
    <section className="ratings-over-time section">
      <h2>Ratings over time</h2>
      <p className="muted chart-caption">
        Compare up to {MAX_SERIES} players. Each keeps its colour and dash pattern while selected, so removing
        one never recolours the rest.
      </p>

      <div className="chart-controls">
        <label className="chart-control">
          <span className="control-label">Granularity</span>
          <select
            className="select"
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as Granularity)}
          >
            <option value="tournament">Per tournament</option>
            <option value="event">Per rating event</option>
          </select>
        </label>
        <label className="chart-control">
          <span className="control-label">Y-axis</span>
          <select className="select" value={yMode} onChange={(e) => setYMode(e.target.value as YMode)}>
            <option value="rating">Skill estimate</option>
            <option value="cautious">Cautious (rating − 2×RD)</option>
          </select>
        </label>
        <label className="chart-control chart-control-search">
          <span className="control-label">Add player</span>
          <input
            className="input"
            type="search"
            placeholder={full ? `${MAX_SERIES} selected — remove one first` : 'Search by name…'}
            value={search}
            disabled={full}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      {searchResults.length > 0 && (
        <ul className="chart-search-results">
          {searchResults.map((player) => (
            <li key={player.playerId}>
              <button
                type="button"
                className="btn btn-small"
                disabled={selectedIds.has(player.playerId)}
                onClick={() => {
                  toggle(player.playerId);
                  setSearch('');
                }}
              >
                {selectedIds.has(player.playerId) ? '✓ ' : '+ '}
                {player.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The legend is also the selection: click to drop a player. */}
      <ul className="chart-legend">
        {selected.map(({ playerId, slot }) => (
          <li key={playerId}>
            <button
              type="button"
              className="legend-item"
              onClick={() => toggle(playerId)}
              title="Remove from chart"
            >
              <svg className="legend-swatch" width="22" height="8" aria-hidden="true">
                <line
                  x1="0"
                  y1="4"
                  x2="22"
                  y2="4"
                  stroke={SERIES_SLOTS[slot]}
                  strokeWidth="2"
                  strokeDasharray={SERIES_DASH[slot]}
                />
              </svg>
              <span className="legend-name">{nameById.get(playerId) ?? '?'}</span>
              <span className="legend-remove" aria-hidden="true">
                ×
              </span>
            </button>
          </li>
        ))}
        {selected.length === 0 && <li className="muted">Search above to add a player.</li>}
      </ul>

      {selected.length === 0 ? (
        <p className="no-data">No players selected.</p>
      ) : (
        <ResponsiveContainer width="100%" height={380}>
          <LineChart data={chartData} margin={{ top: 8, right: directLabels ? 96 : 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="label"
              angle={granularity === 'tournament' ? -30 : 0}
              textAnchor={granularity === 'tournament' ? 'end' : 'middle'}
              height={granularity === 'tournament' ? 88 : 32}
              tick={{ fill: 'var(--text-soft)', fontSize: 10 }}
              stroke="var(--border-strong)"
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              allowDecimals={false}
              domain={['auto', 'auto']}
              tick={{ fill: 'var(--text-soft)', fontSize: 11 }}
              stroke="var(--border-strong)"
              tickLine={false}
              width={48}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const sorted = [...payload]
                  .filter((p) => p.value != null)
                  .sort((a, b) => (b.value as number) - (a.value as number));
                return (
                  <div className="custom-tooltip ratings-tooltip">
                    <p className="tooltip-label">{label}</p>
                    {sorted.map((entry) => (
                      <p key={entry.dataKey as string} className="tooltip-row">
                        <span className="tooltip-swatch" style={{ background: entry.color }} />
                        <span className="tooltip-name">{nameById.get(entry.dataKey as string) ?? '?'}</span>
                        <span className="num">{(entry.value as number).toFixed(0)}</span>
                      </p>
                    ))}
                  </div>
                );
              }}
            />
            {selected.map(({ playerId, slot }) => (
              <Line
                key={playerId}
                type="monotone"
                dataKey={playerId}
                stroke={SERIES_SLOTS[slot]}
                name={playerId}
                dot={false}
                activeDot={{ r: 4, fill: SERIES_SLOTS[slot], stroke: 'var(--bg)', strokeWidth: 2 }}
                connectNulls
                strokeWidth={2}
                strokeDasharray={SERIES_DASH[slot]}
                isAnimationActive={false}
              >
                {directLabels && (
                  <LabelList
                    dataKey={playerId}
                    content={(props: { index?: number; x?: number | string; y?: number | string }) => {
                      if (props.index !== lastIndexOf.get(playerId)) return null;
                      return (
                        <text
                          x={Number(props.x) + 8}
                          y={Number(props.y) + 4}
                          fill={SERIES_SLOTS[slot]}
                          fontSize={11}
                        >
                          {nameById.get(playerId) ?? ''}
                        </text>
                      );
                    }}
                  />
                )}
              </Line>
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}
