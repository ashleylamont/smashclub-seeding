import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { Notice } from '../../components/ui/Feedback';
import { Textarea } from '../../components/ui/Input';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Select, SelectItem } from '../../components/ui/Select';
import { BroadcastSideControls } from './BroadcastSideControls';
import { MatchCard } from './OpsMatchCard';
import { defaultBroadcastStation } from '../../lib/eventDisplay';
import { matchPresentation } from '../../lib/matchPresentation';
import { DEFAULT_PROGRESS_SECONDS } from '../../lib/broadcastProgress';
import { namedStationStart, type DispatchCommandController } from './dispatchCommand';
import type { Desk, Overview } from './dispatchTypes';

export function MainStagePanel({
  data,
  dispatch,
  active,
  disabled,
  unavailable,
  callable,
  act,
}: {
  data: Overview;
  dispatch: DispatchCommandController;
  active: boolean;
  disabled: boolean;
  unavailable: boolean;
  callable: ReadonlySet<string>;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const search = useSearch({ strict: false }) as { station?: string };
  const navigate = useNavigate();
  const [automaticStationId, setAutomaticStationId] = useState<string>();
  const requestedStationId = search.station || automaticStationId;
  const station =
    data.stations.find((item) => item.id === requestedStationId) ??
    (search.station ? data.stations[0] : defaultBroadcastStation(data.stations));
  // Hidden tabs mount before their first visit. Remember the open desk's station across polls.
  if (!search.station && (active || automaticStationId) && station?.id !== automaticStationId)
    setAutomaticStationId(station?.id);
  const match = data.matches.find((item) => item.id === station?.currentMatchId);
  const desk = data.operatorDispatch;
  const matchDisabled = disabled || (desk?.mode === 'shared' && dispatch.busy);
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
            disabled={matchDisabled || unavailable}
            act={act}
          />
          <MatchCard
            key={match.id}
            match={match}
            stations={data.stations}
            disabled={matchDisabled}
            canStart={callable.has(match.id)}
            native={data.plan.bracketMode === 'native'}
            liveOwned={data.plan.liveOwned}
            act={act}
            sharedDispatch={
              desk?.mode === 'shared'
                ? { resourceRevision: desk.resourceRevision, dispatch }
                : undefined
            }
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
          Auto shows tournament progress between sets and returns to gameplay when this station
          starts a match. Progress pages rotate every {DEFAULT_PROGRESS_SECONDS} seconds by default.
          Open a preview to adjust the source in Display setup. Copy here gives you the preset URL.
          To include your changes, use Copy OBS source URL in Display setup. Only Follow event
          overlay uses the event presentation setting.
        </p>
        <BroadcastSources planId={data.plan.id} stationId={station?.id} />
      </Disclosure>
    </section>
  );
}

const broadcastSources = [
  ['auto', 'Automatic intermission overlay'],
  ['gameplay', 'Gameplay-only overlay'],
  ['progress', 'Progress-only overlay'],
  ['event', 'Follow event overlay'],
] as const;

type CopyFeedback = {
  mode: (typeof broadcastSources)[number][0];
  state: 'copying' | 'copied' | 'failed';
  url: string;
};

function BroadcastSources({ planId, stationId }: { planId: string; stationId?: string }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  async function copyUrl(url: string, onState: (state: CopyFeedback['state']) => void) {
    // The clipboard is shared by every row, even when the station changes mid-write.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onState('copying');
    try {
      await navigator.clipboard.writeText(url);
      onState('copied');
    } catch {
      onState('failed');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <BroadcastSourceRows
      key={`${planId}:${stationId ?? ''}`}
      planId={planId}
      stationId={stationId}
      busy={busy}
      copyUrl={copyUrl}
    />
  );
}

function BroadcastSourceRows({
  planId,
  stationId,
  busy,
  copyUrl,
}: {
  planId: string;
  stationId?: string;
  busy: boolean;
  copyUrl: (url: string, onState: (state: CopyFeedback['state']) => void) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<CopyFeedback>();

  useEffect(() => {
    if (feedback?.state !== 'copied') return;
    const timeout = window.setTimeout(
      () => setFeedback((current) => (current === feedback ? undefined : current)),
      3000,
    );
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  return (
    <div className="ops-broadcast-sources">
      {busy && feedback?.state !== 'copying' && (
        <Notice>Waiting for the previous copy to finish.</Notice>
      )}
      {broadcastSources.map(([mode, label]) => {
        const params = new URLSearchParams({
          ...(stationId ? { station: stationId } : {}),
          presentation: mode,
          controls: 'preview',
        });
        const overlay = `/overlay/${encodeURIComponent(planId)}`;
        const previewHref = `${overlay}?${params}`;
        params.set('controls', '0');
        const sourceHref = `${overlay}?${params}`;
        const rowFeedback = feedback?.mode === mode ? feedback : undefined;
        const state = rowFeedback?.state;
        const action = state === 'copying' ? 'Copying' : state === 'copied' ? 'Copied' : 'Copy';
        return (
          <div className="ops-broadcast-source" key={mode}>
            <Button asChild>
              <a href={previewHref} target="_blank" rel="noreferrer">
                {label}
                {'\u00a0'}↗
              </a>
            </Button>
            <Button
              aria-label={`${action} ${label.toLowerCase()} URL`}
              aria-disabled={busy || undefined}
              onClick={() => {
                const url = new URL(sourceHref, window.location.origin).href;
                void copyUrl(url, (state) => setFeedback({ mode, state, url }));
              }}
            >
              {action === 'Copying' ? 'Copying…' : action}
            </Button>
            <span className="visually-hidden" role="status">
              {state === 'copied' && `${label} URL copied.`}
              {state === 'failed' &&
                `Could not copy the ${label.toLowerCase()} URL. Select the URL below to copy it manually.`}
            </span>
            {rowFeedback?.state === 'failed' && (
              <div className="ops-broadcast-source-fallback">
                <Notice tone="warning" live={false}>
                  Clipboard unavailable. Copy this URL, then paste it into OBS.
                  <Textarea
                    className="ops-broadcast-source-url"
                    aria-label={`${label} URL`}
                    readOnly
                    rows={6}
                    value={rowFeedback.url}
                    spellCheck={false}
                  />
                </Notice>
              </div>
            )}
          </div>
        );
      })}
    </div>
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
