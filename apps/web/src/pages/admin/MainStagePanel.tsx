import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Select, SelectItem } from '../../components/ui/Select';
import { BroadcastSideControls } from './BroadcastSideControls';
import { MatchCard } from './OpsMatchCard';
import { matchPresentation } from '../../lib/matchPresentation';
import { namedStationStart, type DispatchCommandController } from './dispatchCommand';
import type { Desk, Overview } from './dispatchTypes';

export function MainStagePanel({
  data,
  dispatch,
  disabled,
  unavailable,
  callable,
  act,
}: {
  data: Overview;
  dispatch: DispatchCommandController;
  disabled: boolean;
  unavailable: boolean;
  callable: ReadonlySet<string>;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const search = useSearch({ strict: false }) as { station?: string };
  const navigate = useNavigate();
  const station = data.stations.find((item) => item.id === search.station) ?? data.stations[0];
  const match = data.matches.find((item) => item.id === station?.currentMatchId);
  const desk = data.operatorDispatch;
  // Run exposes direct named starts only for shared dispatch's reserved resources.
  const idleReservedStation =
    station &&
    !station.currentMatchId &&
    desk?.mode === 'shared' &&
    desk.stations.find(
      (item) => item.id === station.id && item.reserved && item.enabled && !item.currentMatchId,
    );
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
      {dispatch.error && (
        <p role="alert" className="banner banner-danger">
          {dispatch.error}
        </p>
      )}
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
            liveOwned={data.plan.liveOwned}
            act={act}
          />
        </>
      ) : idleReservedStation && desk ? (
        <ReadyStageStart
          key={idleReservedStation.id}
          station={idleReservedStation}
          desk={desk}
          matches={data.matches}
          dispatch={dispatch}
        />
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
          starts a match. In Display setup (S), you can add a Twitch channel before copying the
          updated URL into OBS.
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

function ReadyStageStart({
  station,
  desk,
  matches,
  dispatch,
}: {
  station: Desk['stations'][number];
  desk: Desk;
  matches: Overview['matches'];
  dispatch: DispatchCommandController;
}) {
  const selectedPairingId = useId();
  const [selection, setSelection] = useState<
    { matchId: string; revision: number; resourceRevision: number } | 'changed'
  >();
  const byId = new Map(matches.map((match) => [match.id, match]));
  const ready = desk.queue.flatMap((row) => {
    const match = byId.get(row.matchId);
    return row.state === 'ready' &&
      row.eligibleStationIds.includes(station.id) &&
      match?.status === 'ready'
      ? [match]
      : [];
  });
  const selected =
    selection && selection !== 'changed' && selection.resourceRevision === desk.resourceRevision
      ? ready.find(
          (match) => match.id === selection.matchId && match.revision === selection.revision,
        )
      : undefined;
  // Restoring eligibility later still requires a fresh choice.
  if (selection && selection !== 'changed' && !selected) setSelection('changed');
  if (!ready.length) return <p>No pairings are ready for this station.</p>;
  return (
    <div className="ops-stage-start">
      <label>
        Ready pairing
        <Select
          value={selected?.id ?? ''}
          disabled={dispatch.busy}
          onValueChange={(id) => {
            const match = ready.find((item) => item.id === id);
            setSelection(
              match && {
                matchId: match.id,
                revision: match.revision,
                resourceRevision: desk.resourceRevision,
              },
            );
          }}
        >
          <SelectItem value="">Choose a pairing</SelectItem>
          {ready.map((match) => (
            <SelectItem key={match.id} value={match.id}>
              {match.label} · {matchPresentation(match).title}
            </SelectItem>
          ))}
        </Select>
      </label>
      {selected ? (
        <p id={selectedPairingId} className="ops-stage-pairing">
          {matchPresentation(selected).title}
        </p>
      ) : selection ? (
        <p role="status" className="muted">
          The queue or station setup changed. Choose a pairing again.
        </p>
      ) : null}
      <Button
        variant="primary"
        aria-describedby={selected ? selectedPairingId : undefined}
        disabled={dispatch.busy || !selected}
        onClick={() => {
          if (selected)
            void dispatch.run(
              namedStationStart(selected.id, station.id, selected.revision, desk.resourceRevision),
            );
        }}
      >
        Start on {station.name}
      </Button>
    </div>
  );
}
