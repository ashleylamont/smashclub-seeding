import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Disclosure } from '../../components/ui/Disclosure';
import { Input } from '../../components/ui/Input';
import { useConfirmation } from '../../lib/confirmation';
import type { Desk, Run } from './dispatchTypes';

export function DispatchSetup({
  desk,
  disabled,
  run,
}: {
  desk: Desk;
  disabled: boolean;
  run: Run;
}) {
  const confirm = useConfirmation();
  const [draft, setDraft] = useState<{
    capacity: number;
    selected: string[];
    revision: number;
    capacityEdited?: boolean;
  } | null>(null);
  const [name, setName] = useState('');
  const [stationId, setStationId] = useState(() => crypto.randomUUID());
  const capacity = draft?.capacity ?? desk.capacity;
  const selected =
    draft?.selected ??
    desk.stations.filter((station) => station.reserved).map((station) => station.id);
  const revision = draft?.revision ?? desk.resourceRevision;
  const shared = desk.mode === 'shared';
  const stale = revision !== desk.resourceRevision;
  return (
    <section className="card" id="station-controls" tabIndex={-1}>
      <h3>{shared ? 'Match capacity and named stations' : 'Use a flexible shared match queue'}</h3>
      {!shared && (
        <p>
          Ordinary setups become an unnamed capacity count. Keep only key stations such as Main
          stage reserved by name. Current matches and results are retained; pool holds and reporting
          policies stay as configured.
        </p>
      )}
      <form
        className="dispatch-setup"
        onSubmit={async (event) => {
          event.preventDefault();
          if (stale) return;
          if (
            !shared &&
            !(await confirm(
              `Use ${capacity} ordinary setups plus ${selected.length} named stations? Existing calls stay in place. Pool-to-station reservations will be released; held pools remain held.`,
            ))
          )
            return;
          if (
            await run({
              kind: 'configureDispatch',
              capacity,
              reservedStationIds: selected,
              expectedResourceRevision: revision,
            })
          )
            setDraft(null);
        }}
      >
        <label>
          Ordinary concurrent matches
          <Input
            type="number"
            min={0}
            max={128}
            value={capacity}
            required
            onChange={(e) => {
              setDraft({
                capacity: Number(e.target.value),
                selected,
                revision,
                capacityEdited: true,
              });
            }}
          />
        </label>
        <fieldset>
          <legend>Keep these stations separately reserved</legend>
          {!desk.stations.length && <p>No named stations. Add Main stage below if needed.</p>}
          {desk.stations.map((station) => (
            <label key={station.id}>
              <Checkbox
                checked={selected.includes(station.id)}
                onCheckedChange={(checked) => {
                  const next = checked
                    ? [...selected, station.id]
                    : selected.filter((id) => id !== station.id);
                  setDraft({
                    capacity:
                      shared || draft?.capacityEdited
                        ? capacity
                        : Math.max(0, desk.capacity - next.length),
                    capacityEdited: draft?.capacityEdited,
                    revision,
                    selected: next,
                  });
                }}
              />{' '}
              {station.name}
              {!station.enabled ? ' · unavailable' : ''}
            </label>
          ))}
        </fieldset>
        {stale && (
          <p role="status">
            Resources changed.{' '}
            <Button
              onClick={() => {
                setDraft(null);
              }}
            >
              Load current capacity
            </Button>
          </p>
        )}
        <Button variant="primary" type="submit" disabled={disabled || stale}>
          {shared ? 'Save capacity' : 'Enable shared match queue'}
        </Button>
        <p>
          Total configured capacity: {capacity} ordinary plus{' '}
          {
            selected.filter((id) =>
              desk.stations.some((station) => station.id === id && station.enabled),
            ).length
          }{' '}
          available named stations.
        </p>
      </form>
      {shared && (
        <>
          <div className="dispatch-named-stations">
            {desk.stations
              .filter((s) => s.reserved)
              .map((station) => (
                <div className="dispatch-row" key={station.id}>
                  <strong>{station.name}</strong> ·{' '}
                  {station.currentMatchId
                    ? 'In use'
                    : station.enabled
                      ? 'Available'
                      : 'Unavailable'}
                  <Button
                    size="small"
                    disabled={disabled || Boolean(station.currentMatchId)}
                    onClick={() =>
                      void run({
                        kind: 'resources',
                        capacity: desk.capacity,
                        expectedResourceRevision: desk.resourceRevision,
                        stations: desk.stations.map((s) => ({
                          id: s.id,
                          name: s.name,
                          enabled: s.id === station.id ? !s.enabled : s.enabled,
                          revision: s.revision,
                        })),
                      })
                    }
                  >
                    {station.enabled ? `Disable ${station.name}` : `Enable ${station.name}`}
                  </Button>
                  <Disclosure title={`Rename ${station.name}`}>
                    <form
                      onSubmit={async (event) => {
                        event.preventDefault();
                        const stationName = String(
                          new FormData(event.currentTarget).get('stationName') ?? '',
                        ).trim();
                        if (stationName)
                          await run({
                            kind: 'station',
                            id: station.id,
                            name: stationName,
                            expectedResourceRevision: desk.resourceRevision,
                          });
                      }}
                    >
                      <label>
                        New name for {station.name}
                        <Input
                          key={station.name}
                          name="stationName"
                          defaultValue={station.name}
                          maxLength={60}
                          required
                        />
                      </label>
                      <Button type="submit" disabled={disabled}>
                        Save station name
                      </Button>
                    </form>
                  </Disclosure>
                </div>
              ))}
          </div>
          <form
            className="dispatch-add-station"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await run({
                  kind: 'station',
                  id: stationId,
                  name: name.trim(),
                  expectedResourceRevision: desk.resourceRevision,
                })
              ) {
                setName('');
                setStationId(crypto.randomUUID());
              }
            }}
          >
            <label>
              New reserved station
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setStationId(crypto.randomUUID());
                }}
                maxLength={60}
                placeholder="Main stage"
                required
              />
            </label>
            <Button type="submit" disabled={disabled || !name.trim()}>
              Add reserved station
            </Button>
          </form>
        </>
      )}
    </section>
  );
}
