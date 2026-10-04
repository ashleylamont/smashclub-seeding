import { useConfirmation } from '../../lib/confirmation';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Disclosure } from '../../components/ui/Disclosure';
import { Checkbox } from '../../components/ui/Checkbox';
import { useState } from 'react';
import { PoolStationSetup } from './PoolStationSetup';
import { PoolFloorSheets } from './PoolFloorSheets';
import { BracketBackupSheets } from './BracketBackupSheets';
import { trpc } from '../../lib/trpc';
import { poolStandings } from '../../lib/eventQueue';
import { poolLabel } from '../../lib/poolStationPlan';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;

export function StationPoolControls({
  data,
  disabled,
  act,
  onPool,
  onMatch,
}: {
  data: Overview;
  disabled: boolean;
  act: Action;
  onPool: (key: string) => void;
  onMatch: (id: string) => void;
}) {
  const confirmAction = useConfirmation();
  const [stationName, setStationName] = useState('');
  const [stationCount, setStationCount] = useState(4);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const pools = poolStandings(data.matches);
  return (
    <>
      <section className="card" id="station-controls" tabIndex={-1}>
        <div className="ops-section-heading">
          <h3>Stations</h3>
          <span>
            {data.stations.filter((station) => station.status === 'free').length} of{' '}
            {data.stations.length} free
          </span>
        </div>
        <div className="ops-station-board">
          {data.stations.map((station) => {
            const match = data.matches.find((match) => match.id === station.currentMatchId);
            const queue = data.stationQueues.find((queue) => queue.stationId === station.id);
            const next = data.matches.find((match) => match.id === queue?.nextMatchId);
            const upcoming =
              queue?.upcoming.slice(0, 2).flatMap((item) => {
                const match = data.matches.find((match) => match.id === item.matchId);
                return match ? [{ ...item, match }] : [];
              }) ?? [];
            return (
              <article
                className={`ops-station-tile ${match ? 'is-playing' : 'is-free'}`}
                key={station.id}
              >
                <strong>{station.name}</strong>
                {queue?.poolKey && (
                  <p className="ops-station-owner">
                    {poolLabel({
                      division: queue.poolKey.split(':')[0]!,
                      poolIndex: Number(queue.poolKey.split(':')[1]),
                    })}
                  </p>
                )}
                <span className="chip">{match ? 'Playing now' : 'Free'}</span>
                {match ? (
                  <>
                    <p>
                      {match.player1Name}{' '}
                      <b>
                        {match.score1 ?? 0}–{match.score2 ?? 0}
                      </b>{' '}
                      {match.player2Name}
                    </p>
                    <small>{match.label}</small>
                    <Button
                      size="small"
                      type="button"
                      disabled={disabled}
                      onClick={() => onMatch(match.id)}
                    >
                      Score match
                    </Button>
                  </>
                ) : (
                  <p>Available for the next match</p>
                )}
                {next && (
                  <div className="ops-station-next">
                    <small>PLAY NEXT</small>
                    <p>
                      <strong>
                        {next.player1Name} vs {next.player2Name}
                      </strong>
                    </p>
                    <small>{next.label}</small>
                    <Button
                      size="small"
                      type="submit"
                      disabled={disabled}
                      onClick={() =>
                        void act(
                          () =>
                            trpc.eventOps.updateMatch.mutate({
                              matchId: next.id,
                              expectedRevision: next.revision,
                              status: 'playing',
                              stationId: station.id,
                            }),
                          'Next pool match started',
                        )
                      }
                    >
                      Start next match
                    </Button>
                  </div>
                )}
                {queue?.waitingReason && !next && <p className="muted">{queue.waitingReason}</p>}
                {upcoming.length > 0 && (
                  <div className="ops-station-coming">
                    <small>COMING UP · PROJECTED ORDER</small>
                    <ol>
                      {upcoming.map((item) => (
                        <li key={item.matchId}>
                          {item.match.player1Name} vs {item.match.player2Name}{' '}
                          <small>· Round {item.round}</small>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <a
                  href={`/overlay/${data.plan.id}?station=${encodeURIComponent(station.id)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open this station’s display ↗
                </a>
                <div className="ops-station-actions">
                  <Button
                    size="small"
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setEditingId(station.id);
                      setEditName(station.name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="small"
                    type="button"
                    disabled={disabled || Boolean(match)}
                    title={match ? 'Return the playing match to the queue first' : undefined}
                    onClick={async () => {
                      if (
                        await confirmAction(
                          `Delete ${station.name}? Its idle match assignments and pool reservations will be cleared.`,
                        )
                      )
                        void act(
                          () =>
                            trpc.eventOps.deleteStation.mutate({
                              planId: data.plan.id,
                              id: station.id,
                            }),
                          'Station deleted',
                        );
                    }}
                  >
                    Delete
                  </Button>
                </div>
                {editingId === station.id && (
                  <form
                    className="ops-station-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void act(async () => {
                        await trpc.eventOps.saveStation.mutate({
                          planId: data.plan.id,
                          id: station.id,
                          name: editName,
                        });
                        setEditingId(null);
                      }, 'Station renamed');
                    }}
                  >
                    <label>
                      New name for {station.name}
                      <Input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        maxLength={60}
                        required
                      />
                    </label>
                    <div className="ops-match-actions">
                      <Button size="small" type="submit" disabled={disabled || !editName.trim()}>
                        Save name
                      </Button>
                      <Button size="small" type="button" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
        {!data.stations.length && (
          <p>Add the stations available tonight. Matches can then be assigned to a free station.</p>
        )}
        <Disclosure title="Add stations" className="ops-station-settings">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await trpc.eventOps.saveStation.mutate({ planId: data.plan.id, name: stationName });
                setStationName('');
              }, 'Station added');
            }}
          >
            <label>
              Station name
              <Input
                value={stationName}
                onChange={(event) => setStationName(event.target.value)}
                placeholder="Main stage / Station A"
                maxLength={60}
                required
              />
            </label>
            <Button type="submit" disabled={disabled}>
              Add named station
            </Button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const existing = new Set(
                  data.stations.map((station) => station.name.toLowerCase()),
                );
                let number = 1;
                for (let added = 0; added < stationCount; added++) {
                  while (existing.has(`station ${number}`)) number++;
                  await trpc.eventOps.saveStation.mutate({
                    planId: data.plan.id,
                    name: `Station ${number++}`,
                  });
                }
              }, `${stationCount} stations added`);
            }}
          >
            <label>
              Number of stations to add
              <Input
                type="number"
                min={1}
                max={32}
                value={stationCount}
                onChange={(event) => setStationCount(Number(event.target.value))}
                required
              />
            </label>
            <Button type="submit" disabled={disabled}>
              Add numbered stations
            </Button>
          </form>
        </Disclosure>
      </section>
      {pools.length > 0 && (
        <Disclosure title="Pool queues and stations" className="card ops-pool-settings">
          <p className="muted">
            Reserve a set of stations for each pool. Players follow their round-robin queue while
            other pools wait for the next wave. Pools without assigned stations use unreserved
            stations.
          </p>
          {data.settings.scoreReportingMode === 'approve_unless_disputed' && (
            <p className="muted">
              Event policy: played scores are accepted immediately; conflicting reports go to TO
              review. This overrides the per-pool approval preference.
            </p>
          )}
          <PoolFloorSheets data={data} />
          <BracketBackupSheets data={data} />
          <PoolStationSetup
            key={data.stations.map((station) => station.id).join(':')}
            data={data}
            disabled={disabled}
            act={act}
          />
          <div className="ops-pool-controls">
            {pools.map((pool) => {
              const schedule = data.poolSchedules.find(
                (schedule) =>
                  schedule.division === pool.division && schedule.poolIndex === pool.poolIndex,
              );
              const playing = data.matches.filter(
                (match) =>
                  match.stage === 'group' &&
                  match.division === pool.division &&
                  match.poolIndex === pool.poolIndex &&
                  match.status === 'playing',
              ).length;
              return (
                <PoolSchedule
                  key={`${pool.division}:${pool.poolIndex}:${schedule?.revision ?? 0}`}
                  planId={data.plan.id}
                  native={data.plan.bracketMode === 'native'}
                  pool={pool}
                  schedule={schedule}
                  stations={data.stations}
                  playing={playing}
                  disabled={disabled}
                  act={act}
                  onView={() => onPool(`${pool.division}:${pool.poolIndex}`)}
                />
              );
            })}
          </div>
        </Disclosure>
      )}
    </>
  );
}

function PoolSchedule({
  planId,
  native,
  pool,
  schedule,
  stations,
  playing,
  disabled,
  act,
  onView,
}: {
  planId: string;
  native: boolean;
  pool: ReturnType<typeof poolStandings>[number];
  schedule: Overview['poolSchedules'][number] | undefined;
  stations: Overview['stations'];
  playing: number;
  disabled: boolean;
  act: Action;
  onView: () => void;
}) {
  const [active, setActive] = useState(schedule?.active ?? true);
  const [selected, setSelected] = useState(schedule?.stationIds ?? []);
  const [selfRun, setSelfRun] = useState(schedule?.selfRun ?? false);
  const [autoAcceptScores, setAutoAcceptScores] = useState(schedule?.autoAcceptScores ?? false);
  const done = pool.complete === pool.total;
  const label = `${pool.division === 'upper' ? 'Upper' : 'Lower'} Pool ${String.fromCharCode(65 + pool.poolIndex)}`;
  const changed =
    selfRun !== (schedule?.selfRun ?? false) ||
    (selfRun && autoAcceptScores) !== (schedule?.autoAcceptScores ?? false) ||
    active !== (schedule?.active ?? true) ||
    [...selected].sort().join() !== [...(schedule?.stationIds ?? [])].sort().join();
  return (
    <article className="ops-pool-schedule">
      <div className="ops-section-heading">
        <h4>{label}</h4>
        <span className="chip">
          {done
            ? 'Finished'
            : !schedule?.active && schedule
              ? 'Scheduled later'
              : playing
                ? 'Playing now'
                : pool.complete
                  ? 'In progress'
                  : 'Ready to begin'}
        </span>
      </div>
      <p>
        {pool.complete} / {pool.total} matches complete{playing > 0 && ` · ${playing} playing`}
      </p>
      <label className="ops-check">
        <Checkbox checked={active} disabled={disabled || done} onCheckedChange={setActive} />
        Allow this pool to play now
      </label>
      <fieldset disabled={disabled || done}>
        <legend>Stations for {label}</legend>
        {stations.map((station) => (
          <label className="ops-check" key={station.id}>
            <Checkbox
              checked={selected.includes(station.id)}
              onCheckedChange={(nextChecked) =>
                setSelected(
                  nextChecked
                    ? [...selected, station.id]
                    : selected.filter((id) => id !== station.id),
                )
              }
            />
            {station.name}
          </label>
        ))}
      </fieldset>
      <label className="ops-check">
        <Checkbox
          checked={selfRun}
          disabled={disabled || done || !native}
          onCheckedChange={(nextChecked) => {
            setSelfRun(nextChecked);
            if (nextChecked) setAutoAcceptScores(true);
          }}
        />
        Players can start queued matches
      </label>
      <label className="ops-check">
        <Checkbox
          checked={selfRun && autoAcceptScores}
          disabled={disabled || done || !selfRun}
          onCheckedChange={setAutoAcceptScores}
        />
        Accept scores immediately, without TO approval
      </label>
      {selfRun && !selected.length && (
        <p className="error-text">Assign stations before allowing players to run this pool.</p>
      )}
      <p>
        <a
          href={`/live/${planId}?pool=${pool.division}:${pool.poolIndex}`}
          target="_blank"
          rel="noreferrer"
        >
          Open this pool’s player board ↗
        </a>
      </p>
      <div className="ops-match-actions">
        <Button
          size="small"
          type="submit"
          disabled={disabled || done || !changed || (selfRun && !selected.length)}
          onClick={() =>
            void act(
              () =>
                trpc.eventOps.configurePool.mutate({
                  planId,
                  division: pool.division as 'upper' | 'lower',
                  poolIndex: pool.poolIndex,
                  active,
                  stationIds: selected,
                  selfRun,
                  autoAcceptScores: selfRun && autoAcceptScores,
                  expectedRevision: schedule?.revision ?? 0,
                }),
              'Pool queue updated',
            )
          }
        >
          Save pool settings
        </Button>
        <Button size="small" type="submit" onClick={onView}>
          View pool matches
        </Button>
      </div>
    </article>
  );
}
