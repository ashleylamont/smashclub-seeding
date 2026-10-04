import { Disclosure } from '../../components/ui/Disclosure';
import { Checkbox } from '../../components/ui/Checkbox';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { useState } from 'react';
import { trpc } from '../../lib/trpc';
import { poolStandings } from '../../lib/eventQueue';
import { distributePoolStations, nextPoolWave, poolLabel } from '../../lib/poolStationPlan';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
export function PoolStationSetup({
  data,
  disabled,
  act,
}: {
  data: Overview;
  disabled: boolean;
  act: Action;
}) {
  const [perPool, setPerPool] = useState(2);
  const [selected, setSelected] = useState(data.stations.map((station) => station.id));
  const [selfRun, setSelfRun] = useState(data.plan.bracketMode === 'native');
  const [autoAcceptScores, setAutoAcceptScores] = useState(true);
  const [preview, setPreview] = useState<ReturnType<typeof distributePoolStations> | null>(null);
  const pools = poolStandings(data.matches);
  const stationOptions = [...data.stations].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id),
  );
  const proposed = distributePoolStations(
    pools,
    stationOptions.filter((station) => selected.includes(station.id)).map((station) => station.id),
    perPool,
    data.poolSchedules,
    { selfRun, autoAcceptScores },
  );
  const nextWave = nextPoolWave(
    pools,
    data.poolSchedules,
    data.stations.filter((station) => station.status === 'occupied').map((station) => station.id),
  );
  const playing = data.matches.some((match) => match.status === 'playing');
  const stationNames = (ids: string[]) =>
    ids
      .map((id) => data.stations.find((station) => station.id === id)?.name ?? 'Station')
      .join(' + ');
  return (
    <div className="ops-pool-setup">
      <Disclosure title="Divide stations between pools">
        {data.settings.scoreReportingMode === 'approve_unless_disputed' && (
          <p>
            The event’s approve-unless-disputed policy accepts played scores immediately. Pool
            approval preferences below apply when the event uses TO approval.
          </p>
        )}
        <p>
          Give each pool its own stations and a round-robin queue. Extra pools wait for a later wave
          on the same stations. Review the assignments before applying.
        </p>
        {playing && (
          <p className="muted">
            Finish or return playing matches to the queue before redistributing all stations.
            Individual pool settings remain available below.
          </p>
        )}
        <fieldset disabled={disabled || playing}>
          <legend>Stations to use</legend>
          {stationOptions.map((station) => (
            <label className="ops-check" key={station.id}>
              <Checkbox
                checked={selected.includes(station.id)}
                onCheckedChange={(nextChecked) => {
                  setSelected(
                    nextChecked
                      ? [...selected, station.id]
                      : selected.filter((id) => id !== station.id),
                  );
                  setPreview(null);
                }}
              />
              {station.name}
            </label>
          ))}
        </fieldset>
        <label>
          Stations per pool
          <Select
            value={perPool}
            disabled={disabled || playing}
            onValueChange={(selectedValue) => {
              setPerPool(Number(selectedValue));
              setPreview(null);
            }}
          >
            {[1, 2, 3, 4].map((count) => (
              <SelectItem key={count} value={count}>
                {count}
              </SelectItem>
            ))}
          </Select>
        </label>
        <p className="muted">
          A four- or five-player pool can play two matches at once. An odd player rests each round.
        </p>
        <label className="ops-check">
          <Checkbox
            checked={selfRun}
            disabled={disabled || playing || data.plan.bracketMode !== 'native'}
            onCheckedChange={(nextChecked) => {
              setSelfRun(nextChecked);
              setPreview(null);
            }}
          />
          Let players start their pool’s next matches
        </label>
        <label className="ops-check">
          <Checkbox
            checked={selfRun && autoAcceptScores}
            disabled={disabled || playing || !selfRun}
            onCheckedChange={(nextChecked) => {
              setAutoAcceptScores(nextChecked);
              setPreview(null);
            }}
          />
          Accept player scores immediately in these pools
        </label>
        <p className="muted">
          {selfRun && autoAcceptScores
            ? 'Players start the next match, report its final score and move on. Results are audited; TOs can correct mistakes.'
            : 'Scores wait for TO approval before the next match becomes available.'}{' '}
          {data.plan.bracketMode !== 'native' && 'Player starts require a native Nemesis event.'}
        </p>
        <Button
          type="submit"
          disabled={disabled || playing || !proposed.length}
          onClick={() => setPreview(proposed)}
        >
          Review station plan
        </Button>
        {preview && (
          <div className="ops-station-plan">
            <h4>Proposed pool stations</h4>
            <ul>
              {preview.map((pool) => (
                <li key={`${pool.division}:${pool.poolIndex}`}>
                  <strong>{poolLabel(pool)}</strong> → {stationNames(pool.stationIds)}{' '}
                  <span className="chip">
                    {pool.wave
                      ? `Wave ${pool.wave}${pool.active ? ' · Play now' : ' · Waiting'}`
                      : 'Finished · Release stations'}
                  </span>
                </li>
              ))}
            </ul>
            <p>
              {selfRun ? 'Players can start queued matches.' : 'TOs start matches.'}{' '}
              {selfRun && autoAcceptScores
                ? 'Player scores immediately finish matches.'
                : 'Player scores require TO approval.'}
            </p>
            <Button
              variant="primary"
              type="submit"
              disabled={disabled || playing}
              onClick={() =>
                void act(async () => {
                  await trpc.eventOps.configurePools.mutate({
                    planId: data.plan.id,
                    pools: preview.map((pool) => ({
                      division: pool.division,
                      poolIndex: pool.poolIndex,
                      active: pool.active,
                      stationIds: pool.stationIds,
                      selfRun: pool.selfRun,
                      autoAcceptScores: pool.autoAcceptScores,
                      expectedRevision: pool.expectedRevision,
                    })),
                  });
                  setPreview(null);
                }, 'Pool stations and round-robin queues ready')
              }
            >
              Apply station plan
            </Button>
          </div>
        )}
      </Disclosure>
      {nextWave.length > 0 && (
        <div className="ops-next-wave">
          <h4>Ready for the next pools</h4>
          <p>
            {nextWave
              .filter((pool) => pool.active)
              .map((pool) => `${poolLabel(pool)} on ${stationNames(pool.stationIds)}`)
              .join(' · ')}
          </p>
          <Button
            type="submit"
            disabled={disabled}
            onClick={() =>
              void act(
                () =>
                  trpc.eventOps.configurePools.mutate({ planId: data.plan.id, pools: nextWave }),
                'Next pools can play now',
              )
            }
          >
            Open next pools on free stations
          </Button>
        </div>
      )}
    </div>
  );
}
