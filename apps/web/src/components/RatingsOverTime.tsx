import { Select, SelectItem } from './ui/Select';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { LoadingState, Notice } from './ui/Feedback';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import { useCallback, useId, useMemo, useState } from 'react';
import {
  CartesianGrid,
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
  players: RatingHistoryData['players'];
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
const CHART_MARGIN = { top: 8, right: 16, bottom: 4, left: 0 };
const Y_AXIS_WIDTH = 48;
const PLOT_GUTTERS = CHART_MARGIN.left + CHART_MARGIN.right + Y_AXIS_WIDTH;

/** How many players are pre-selected on first render. */
const DEFAULT_SELECTION = 5;

type YMode = 'rating' | 'cautious';

interface Snapshot {
  label: string;
  values: Record<string, number>;
  attendance: Record<string, boolean>;
  unavailable: boolean;
}

export function RatingsOverTime({ players }: RatingsOverTimeProps) {
  const [yMode, setYMode] = useState<YMode>('rating');
  const [search, setSearch] = useState('');
  const conservativeDescriptionId = useId();

  /**
   * playerId -> colour slot. The array position *is* the slot, so a player
   * keeps their colour until they are removed, and a freed slot is reused by
   * whoever is added next.
   */
  const [slots, setSlots] = useState<(string | null)[]>(() => {
    const initial: (string | null)[] = Array.from({ length: MAX_SERIES }, () => null);
    players.slice(0, DEFAULT_SELECTION).forEach((player, i) => {
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
  const playerIds = useMemo(() => selected.map(({ playerId }) => playerId).sort(), [selected]);
  const selectedIds = useMemo(() => new Set(playerIds), [playerIds]);
  const nightly = useQuery({
    queryKey: ['ratingNightHistory', playerIds],
    queryFn: () => trpc.public.ratingNightHistory.query({ playerIds, verifiedFits: true }),
    enabled: playerIds.length > 0,
  });
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

  const nameById = useMemo(() => new Map(players.map((p) => [p.playerId, p.name])), [players]);

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return players.filter((p) => p.name.toLowerCase().includes(query)).slice(0, 8);
  }, [players, search]);

  const chartData = useMemo(() => {
    if (!nightly.data) return [];
    const byNight = new Map(
      nightly.data.eventKeys.map((label): [string, Snapshot] => [
        label,
        { label, values: {}, attendance: {}, unavailable: false },
      ]),
    );
    for (const { eventKey, playerId, postRating, postRd, played } of nightly.data.points) {
      const night = byNight.get(eventKey)!;
      if (postRating === null || postRd === null) {
        night.unavailable = true;
      } else {
        night.values[playerId] = yMode === 'cautious' ? postRating - 2 * postRd : postRating;
        night.attendance[playerId] = played;
      }
    }
    return [...byNight.values()];
  }, [nightly.data, yMode]);

  return (
    <section className="ratings-over-time section">
      <h2>Ratings over time</h2>
      <p className="muted chart-caption">
        Compare up to {MAX_SERIES} players. Each estimate uses results through that club night.
        {Boolean(nightly.data?.points.length) &&
          (nightly.data?.mode === 'played'
            ? ' Showing the available played-night estimates.'
            : ' Estimates include missed nights.')}
        {chartData.some((night) => night.unavailable) && ' Gaps show unavailable night estimates.'}
      </p>

      <div className="chart-controls">
        <label className="chart-control">
          <span className="control-label">Y-axis</span>
          <Select
            aria-describedby={yMode === 'cautious' ? conservativeDescriptionId : undefined}
            value={yMode}
            onValueChange={(selectedValue) => setYMode(selectedValue as YMode)}
          >
            <SelectItem value="rating">Skill estimate</SelectItem>
            <SelectItem value="cautious">Conservative</SelectItem>
          </Select>
        </label>
        <label className="chart-control chart-control-search">
          <span className="control-label">Add player</span>
          <Input
            type="search"
            placeholder={full ? `${MAX_SERIES} selected — remove one first` : 'Search by name…'}
            value={search}
            disabled={full}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      {yMode === 'cautious' && (
        <p className="muted chart-caption" id={conservativeDescriptionId}>
          Subtracts two standard deviations from each historical skill estimate. Automatic bracket
          seeds use the draw’s saved ratings, which can include rookie adjustments.
        </p>
      )}

      {searchResults.length > 0 && (
        <ul className="chart-search-results">
          {searchResults.map((player) => (
            <li key={player.playerId}>
              <Button
                size="small"
                type="button"
                disabled={selectedIds.has(player.playerId)}
                onClick={() => {
                  toggle(player.playerId);
                  setSearch('');
                }}
              >
                {selectedIds.has(player.playerId) ? '✓ ' : '+ '}
                {player.name}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* The legend is also the selection: click to drop a player. */}
      <ul className="chart-legend">
        {selected.map(({ playerId, slot }) => (
          <li key={playerId}>
            <Button
              variant="plain"
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
            </Button>
          </li>
        ))}
        {selected.length === 0 && <li className="muted">Search above to add a player.</li>}
      </ul>

      {selected.length === 0 ? (
        <p className="no-data">No players selected.</p>
      ) : nightly.isPending ? (
        <LoadingState>Loading night estimates…</LoadingState>
      ) : nightly.isError ? (
        <Notice tone="danger">
          Night estimates could not be loaded.{' '}
          <Button variant="plain" className="link-button" onClick={() => void nightly.refetch()}>
            Try again
          </Button>
        </Notice>
      ) : !nightly.data.points.length ? (
        <p className="no-data">No night estimates for these players.</p>
      ) : (
        <ResponsiveContainer width="100%" height={380}>
          <LineChart
            data={chartData}
            margin={CHART_MARGIN}
            aria-label="Player estimates by club night"
          >
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="label"
              angle={-30}
              textAnchor={'end'}
              height={88}
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
              width={Y_AXIS_WIDTH}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)' }}
              // Recharts positions the tooltip within the plot, excluding the axes and gutters.
              wrapperStyle={{ maxWidth: `calc(100% - ${PLOT_GUTTERS}px)` }}
              // Recharts hides the whole tooltip when its filtered payload is empty.
              filterNull={false}
              content={({ active, payload, label }) => {
                if (!active || typeof label !== 'string') return null;
                const estimates = payload
                  .filter(
                    (entry): entry is typeof entry & { value: number } =>
                      entry.hide !== true && typeof entry.value === 'number',
                  )
                  .sort((a, b) => b.value - a.value);
                const night = chartData.find((point) => point.label === label);
                return (
                  <div className="custom-tooltip ratings-tooltip" role="status">
                    <p className="tooltip-label">{label}</p>
                    {estimates.length === 0 && (
                      <p>
                        {night?.unavailable
                          ? 'Night estimate unavailable.'
                          : 'No recorded estimates for these players.'}
                      </p>
                    )}
                    {estimates.map((entry) => (
                      <p key={entry.name as string} className="tooltip-row">
                        <span className="tooltip-swatch" style={{ background: entry.color }} />
                        <span className="tooltip-name">
                          {nameById.get(entry.name as string) ?? '?'}
                          {night?.attendance[entry.name as string] === false && (
                            <span className="tooltip-attendance">Missed night</span>
                          )}
                        </span>
                        <span className="num">{entry.value.toFixed(0)}</span>
                      </p>
                    ))}
                  </div>
                );
              }}
            />
            {selected.map(({ playerId, slot }) => (
              <Line
                key={playerId}
                type="linear"
                dataKey={`values.${playerId}`}
                stroke={SERIES_SLOTS[slot]}
                name={playerId}
                dot={{ r: 2, fill: SERIES_SLOTS[slot], strokeWidth: 0 }}
                activeDot={{ r: 4, fill: SERIES_SLOTS[slot], stroke: 'var(--bg)', strokeWidth: 2 }}
                strokeWidth={2}
                strokeDasharray={SERIES_DASH[slot]}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}
