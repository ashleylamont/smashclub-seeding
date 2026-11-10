import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  broadcastPageDensity,
  broadcastProgressPages,
  type PoolPanel,
  type ProgressData,
  type ProgressPage,
} from '../lib/broadcastProgress';
import { liveBracketWinner } from '../lib/eventBracket';
import { linkedFinalCaption } from '../lib/linkedFinalCaption';
import { poolTitle } from '../lib/poolFlow';
import { matchParticipantName, matchPresentation } from '../lib/matchPresentation';
import { finalsFieldLabel, qualifierDetail } from '../lib/qualification';
import { EventBracketLane } from './EventBracketLane';
import { IntermissionRecentResults } from './IntermissionRecentResults';
import { NemesisMark } from './NemesisMark';
import { OverlayTwitchLink } from './OverlayTwitch';
import { Button } from './ui/Button';
import { Progress } from './ui/Progress';
import './BroadcastIntermission.css';

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

export function BroadcastIntermission({
  data,
  seconds,
  announcement,
  controls,
  twitchChannel,
  preferRecent,
}: {
  data: ProgressData;
  seconds: number;
  announcement: string;
  controls: boolean;
  twitchChannel: string;
  preferRecent: boolean;
}) {
  const [current, setCurrent] = useState('');
  const [viewportWidth, setViewportWidth] = useState(() => innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const density = broadcastPageDensity(viewportWidth);
  const pages = useMemo(
    () => broadcastProgressPages(data, preferRecent, broadcastPageDensity(viewportWidth)),
    [data, preferRecent, viewportWidth],
  );
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const keys = pages.map((page) => page.key).join('|');
  const index = Math.max(
    0,
    pages.findIndex((page) => page.key === current),
  );
  const multiplePages = pages.length > 1;
  const page = pages[index]!;
  const move = useCallback(
    (direction: number, fromPage?: string) => {
      if (!multiplePages) return;
      const pageKeys = keys.split('|');
      setCurrent((previous) => {
        const previousIndex = Math.max(0, pageKeys.indexOf(previous));
        if (fromPage && pageKeys[previousIndex] !== fromPage) return previous;
        return pageKeys[(previousIndex + direction + pageKeys.length) % pageKeys.length]!;
      });
    },
    [keys, multiplePages],
  );
  const advance = useCallback(() => move(1, page.key), [move, page.key]);
  useEffect(() => {
    if (!multiplePages) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,select,textarea,button,[contenteditable="true"]'))
      )
        return;
      const direction =
        event.key === 'ArrowRight' || event.key === 'PageDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'PageUp'
            ? -1
            : 0;
      if (!direction) return;
      move(direction);
      event.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [move, multiplePages]);
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const labels = new Map(data.matches.map((match) => [match.id, match.label]));
  const entrantNames = new Map(data.entrants.map(({ id, name }) => [id, name]));

  return (
    <section className="broadcast-intermission" aria-label="Tournament progress">
      <header className="intermission-heading">
        <NemesisMark />
        <div>
          <p>Smash Club</p>
          <h1>{data.plan.name}</h1>
        </div>
        <span>
          {data.plan.status === 'cancelled'
            ? 'Event cancelled'
            : data.plan.status === 'complete'
              ? 'Event complete'
              : 'Intermission'}
        </span>
      </header>
      <div className="intermission-content" key={page.key}>
        {page.kind === 'pool' ? (
          <div className={page.panels.length > 1 ? 'intermission-pool-grid' : undefined}>
            {page.panels.map((panel) => (
              <PoolStandingsPanel
                key={panel.key}
                panel={panel}
                closed={closed}
                structure={data.plan.structure}
                entrantNames={entrantNames}
              />
            ))}
          </div>
        ) : page.kind === 'round-robin-results' ? (
          <RoundRobinResultsPage page={page} entrants={data.entrants} />
        ) : page.kind === 'linked' ? (
          <LinkedBracketPage page={page} closed={closed} />
        ) : page.kind === 'recent-results' ? (
          <IntermissionRecentResults matches={page.matches} />
        ) : page.kind === 'bracket' ? (
          <>
            <div className="intermission-section-heading">
              <h2>
                {page.bracket.division} ·{' '}
                {page.bracket.stage === 'main' ? 'Championship' : 'Consolation'}
                {page.lane.title ? ` · ${page.lane.title}` : ''}
              </h2>
            </div>
            {page.bracket.complete && page.bracket.winnerId && (
              <p className="intermission-winner">
                Confirmed winner ·{' '}
                {data.entrants.find((entrant) => entrant.id === page.bracket.winnerId)?.name ??
                  'Player'}
              </p>
            )}
            <EventBracketLane
              matches={page.matches}
              lane={page.lane.key}
              title={page.lane.title || 'Bracket'}
              label="Bracket progress section"
              labels={labels}
              roundWindow
              recordedOnly={closed}
              cardWidth={Math.min(
                Math.round(viewportWidth * (density.bracketColumns === 1 ? 0.92 : 0.4)),
                Math.floor(
                  (viewportWidth * 0.92) /
                    Math.min(density.bracketColumns, page.roundTitles.length),
                ) - 36,
              )}
              roundTitles={page.roundTitles}
            />
          </>
        ) : (
          <div className="intermission-summary">
            <h2>
              {closed
                ? 'Recorded tournament results'
                : data.matches.length
                  ? 'Tournament progress'
                  : 'Waiting for the draw'}
            </h2>
            {data.matches.length > 0 ? (
              <p className="intermission-set-count">
                {data.matches.filter((match) => match.status === 'complete').length} /{' '}
                {data.matches.length} sets complete
              </p>
            ) : closed ? (
              <p>No results recorded.</p>
            ) : null}
            <p className="intermission-public-link">
              Event info &amp; results <strong>{eventUrl(data)}</strong>
            </p>
          </div>
        )}
      </div>
      <footer className="intermission-footer">
        {announcement && <p className="intermission-announcement">{announcement}</p>}
        <div className="intermission-navigation">
          <div className="intermission-pagination">
            <span>
              Page {index + 1} / {pages.length}
            </span>
            {multiplePages &&
              (reduced ? (
                <span className="intermission-rotation-state">Manual</span>
              ) : paused ? (
                <span className="intermission-rotation-state">Paused</span>
              ) : (
                <PageTimer
                  key={`${keys}:${page.key}:${seconds}`}
                  seconds={seconds}
                  onNext={advance}
                />
              ))}
          </div>
          {twitchChannel && <OverlayTwitchLink channel={twitchChannel} />}
          {controls && multiplePages && (
            <div className="intermission-controls">
              <Button onClick={() => move(-1)}>Previous page</Button>
              <Button onClick={() => move(1)}>Next page</Button>
              {!reduced && (
                <Button onClick={() => setPaused((value) => !value)}>
                  {paused ? 'Resume rotation' : 'Pause rotation'}
                </Button>
              )}
            </div>
          )}
        </div>
      </footer>
    </section>
  );
}

function eventUrl(data: ProgressData) {
  const path =
    data.publicCode === undefined
      ? `/play/${encodeURIComponent(data.plan.id)}`
      : `/e/${data.publicCode}`;
  return `${location.origin}${path}`;
}

function PageTimer({ seconds, onNext }: { seconds: number; onNext: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const duration = seconds * 1000;
  useEffect(() => {
    const started = performance.now();
    const tick = window.setInterval(
      () => setElapsed(Math.min(duration, performance.now() - started)),
      125,
    );
    const turn = window.setTimeout(onNext, duration);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(turn);
    };
  }, [duration, onNext]);
  const remaining = Math.ceil((duration - elapsed) / 1000);
  return (
    <span className="intermission-countdown">
      <Progress
        className="intermission-timer"
        label="Page rotation"
        value={elapsed}
        max={duration}
        aria-valuetext={`${remaining} seconds until next page`}
      />
      <span aria-hidden="true">{remaining}s</span>
    </span>
  );
}

function RoundRobinResultsPage({
  page,
  entrants,
}: {
  page: Extract<ProgressPage, { kind: 'round-robin-results' }>;
  entrants: ProgressData['entrants'];
}) {
  const names = new Map(entrants.map(({ id, name }) => [id, name]));
  return (
    <>
      <div className="intermission-section-heading">
        <h2>Round-robin results</h2>
      </div>
      {page.winnerId && (
        <p className="intermission-winner">
          Confirmed winner · {names.get(page.winnerId) ?? 'Player'}
        </p>
      )}
      <table
        className="intermission-standings intermission-round-robin"
        aria-label="Confirmed round-robin standings"
      >
        <thead>
          <tr>
            <th scope="col">Place</th>
            <th scope="col">Entrant</th>
          </tr>
        </thead>
        <tbody>
          {page.standings.map(({ place, playerId }) => (
            <tr
              key={playerId}
              className={playerId === page.winnerId ? 'intermission-official-winner' : undefined}
            >
              <td>{place}</td>
              <td>{names.get(playerId) ?? 'Player'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function PoolStandingsPanel({
  panel: { pool, players, qualifications },
  closed,
  structure,
  entrantNames,
}: {
  panel: PoolPanel;
  closed: boolean;
  structure?: string;
  entrantNames: ReadonlyMap<string, string>;
}) {
  const heading = poolTitle(`${pool.division}:${pool.poolIndex}`, structure, 'heading');
  const shortStage = (stage: PoolPanel['qualifications'][number]['stage']) =>
    stage === 'main' ? 'Championship' : 'Consolation';
  const displayed = new Set(players.map(({ id }) => id));
  const remaining = qualifications.filter(
    ({ status, entrantId }) => status !== 'resolved' || !entrantId || !displayed.has(entrantId),
  );
  const slotGroups = new Map<string, number[]>();
  for (const slot of remaining) {
    const detail = qualifierDetail(slot, entrantNames) ?? 'Awaiting qualification';
    const key = `${shortStage(slot.stage)} · ${detail}`;
    const places = slotGroups.get(key) ?? [];
    places.push(slot.place);
    slotGroups.set(key, places);
  }
  return (
    <section className="intermission-pool-panel" aria-label={heading}>
      <div className="intermission-section-heading">
        <h2>{heading}</h2>
        {pool.total > 0 && (
          <div className="intermission-pool-status">
            <span className="intermission-set-count">
              {pool.complete} / {pool.total} sets complete
            </span>
            <Progress
              className="intermission-pool-meter"
              label="Pool sets completed"
              value={pool.complete}
              max={pool.total}
            />
          </div>
        )}
      </div>
      {players.length > 0 && (
        <table className="intermission-standings" aria-label={heading}>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Sets W–L</th>
              <th scope="col">Games ±</th>
              <th scope="col">{closed ? 'No result' : 'To play'}</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player) => {
              const confirmed = qualifications.filter(
                ({ entrantId, status }) => entrantId === player.id && status === 'resolved',
              );
              return (
                <tr key={player.id}>
                  <td>
                    {player.name}
                    {confirmed.map(({ stage, place }) => (
                      <strong className="intermission-qualifier" key={`${stage}:${place}`}>
                        Qualified · {shortStage(stage)} · #{place}
                      </strong>
                    ))}
                  </td>
                  <td>
                    {player.wins}–{player.losses}
                  </td>
                  <td>
                    {player.differential > 0 ? '+' : ''}
                    {player.differential}
                  </td>
                  <td>{player.remaining}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {slotGroups.size > 0 && (
        <ul className="intermission-qualification" aria-label="Finals qualification">
          {[...slotGroups].map(([label, places]) => (
            <li key={label}>
              {places.map((place) => `#${place}`).join(', ')} · {label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LinkedBracketPage({
  page,
  closed,
}: {
  page: Extract<ProgressPage, { kind: 'linked' }>;
  closed: boolean;
}) {
  const heading = `Linked ${finalsFieldLabel(page.bracket)} bracket`;
  return (
    <>
      <div className="intermission-section-heading">
        <h2>{heading}</h2>
      </div>
      <table className="intermission-standings intermission-linked" aria-label={heading}>
        <thead>
          <tr>
            <th>Match</th>
            <th>First entrant</th>
            <th>Second entrant</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {page.matches.map((match) => {
            const presentation = matchPresentation(match, closed);
            const status =
              presentation.status ??
              (match.called
                ? 'Called'
                : match.status === 'playing'
                  ? 'Playing'
                  : match.status === 'blocked'
                    ? 'On hold'
                    : 'Upcoming');
            return (
              <tr key={match.id}>
                <td>{linkedFinalCaption(match)?.identifier ?? match.label}</td>
                {([0, 1] as const).map((side) => {
                  const id = side === 0 ? match.player1Id : match.player2Id;
                  const name = id ? matchParticipantName(match, side) : '—';
                  return (
                    <td key={side}>
                      {liveBracketWinner(match, id) ? <strong>{name} · Winner</strong> : name}
                    </td>
                  );
                })}
                <td>
                  {presentation.kind === 'played' &&
                  match.score1 !== null &&
                  match.score2 !== null ? (
                    <span className="intermission-linked-score">
                      {match.score1}–{match.score2}
                    </span>
                  ) : (
                    status
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
