import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Select, SelectItem } from '../../components/ui/Select';
import { BroadcastSideControls } from './BroadcastSideControls';
import { MatchCard } from './OpsMatchCard';
import type { Overview } from './dispatchTypes';

export function MainStagePanel({
  data,
  disabled,
  unavailable,
  callable,
  act,
}: {
  data: Overview;
  disabled: boolean;
  unavailable: boolean;
  callable: ReadonlySet<string>;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const search = useSearch({ strict: false }) as { station?: string };
  const navigate = useNavigate();
  const station = data.stations.find((item) => item.id === search.station) ?? data.stations[0];
  const match = data.matches.find((item) => item.id === station?.currentMatchId);
  return (
    <section className="card ops-main-stage">
      <h3>Main stage</h3>
      <label>
        Station
        <Select
          value={station?.id ?? ''}
          onValueChange={(station) =>
            void navigate({
              to: '.',
              search: (previous) => ({ ...previous, station }),
              resetScroll: false,
            })
          }
        >
          {!data.stations.length && <SelectItem value="">No stations configured</SelectItem>}
          {data.stations.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
        </Select>
      </label>
      {match ? (
        <>
          <BroadcastSideControls
            key={`sides:${match.id}`}
            data={data}
            match={match}
            disabled={disabled || unavailable}
            act={act}
          />
          <MatchCard
            key={match.id}
            match={match}
            stations={data.stations}
            disabled={disabled}
            canStart={callable.has(match.id)}
            native={data.plan.bracketMode === 'native'}
            act={act}
          />
        </>
      ) : (
        <p>No match playing at this station.</p>
      )}
      <a
        className="btn"
        href={`/overlay/${data.plan.id}${station ? `?station=${station.id}` : ''}`}
        target="_blank"
        rel="noreferrer"
      >
        Open station overlay ↗
      </a>
      <Disclosure title="Intermission browser sources">
        <p>
          Auto shows tournament progress between games and returns to gameplay when this station
          starts a match. Copy the chosen URL into OBS.
        </p>
        <div className="ops-broadcast-source-links">
          {(['auto', 'progress'] as const).map((mode) => (
            <Button asChild key={mode}>
              <a
                href={`/overlay/${encodeURIComponent(data.plan.id)}?${new URLSearchParams({ ...(station ? { station: station.id } : {}), presentation: mode, controls: '0' })}`}
                target="_blank"
                rel="noreferrer"
              >
                {mode === 'auto' ? 'Automatic intermission overlay ↗' : 'Progress-only overlay ↗'}
              </a>
            </Button>
          ))}
        </div>
      </Disclosure>
    </section>
  );
}
