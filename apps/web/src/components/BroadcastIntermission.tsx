import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  broadcastProgressPages,
  type ProgressData,
  type ProgressPage,
} from '../lib/broadcastProgress';
import { liveBracketWinner } from '../lib/eventBracket';
import { linkedFinalCaption } from '../lib/linkedFinalCaption';
import { poolTitle } from '../lib/poolFlow';
import { matchParticipantName, matchPresentation } from '../lib/matchPresentation';
import { finalsFieldLabel, qualifierDetail, qualifierLabel } from '../lib/qualification';
import { EventBracketLane } from './EventBracketLane';
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
}: {
  data: ProgressData;
  seconds: number;
  announcement: string;
  controls: boolean;
  twitchChannel: string;
}) {
  const pages = useMemo(() => broadcastProgressPages(data), [data]);
  const [current, setCurrent] = useState('');
  const [viewportWidth, setViewportWidth] = useState(() => innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
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
          <PoolPage
            page={page}
            closed={closed}
            structure={data.plan.structure}
            confirmedRoundRobin={pages.some((item) => item.kind === 'round-robin-results')}
          />
        ) : page.kind === 'round-robin-results' ? (
          <RoundRobinResultsPage page={page} entrants={data.entrants} />
        ) : page.kind === 'qualification' ? (
          <QualificationPage page={page} entrants={data.entrants} />
        ) : page.kind === 'linked' ? (
          <LinkedBracketPage page={page} closed={closed} />
        ) : page.kind === 'bracket' ? (
          <>
            <div className="intermission-section-heading">
              <h2>
                {page.bracket.division} ·{' '}
                {page.bracket.stage === 'main' ? 'Championship' : 'Consolation'}
              </h2>
            </div>
            {page.bracket.complete && page.bracket.winnerId && (
              <p className="intermission-winner">
                Confirmed winner ·{' '}
                {data.entrants.find((entrant) => entrant.id === page.bracket.winnerId)?.name ??
                  'Player'}
              </p>
            )}
            {page.matches.length ? (
              <EventBracketLane
                matches={page.matches}
                lane={page.lane.key}
                title={page.lane.title || 'Bracket'}
                label="Bracket progress section"
                labels={labels}
                roundWindow
                recordedOnly={closed}
                cardWidth={Math.max(250, Math.round(viewportWidth * 0.36))}
                roundTitles={page.roundTitles}
              />
            ) : (
              <p>
                {page.bracket.complete
                  ? 'No played sets.'
                  : 'The draw has no published matches yet.'}
              </p>
            )}
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
        {(announcement || twitchChannel) && (
          <div className="intermission-footer-info">
            {announcement && <p>{announcement}</p>}
            {twitchChannel && <OverlayTwitchLink channel={twitchChannel} />}
          </div>
        )}
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

function PoolPage({
  page,
  closed,
  structure,
  confirmedRoundRobin,
}: {
  page: Extract<ProgressPage, { kind: 'pool' }>;
  closed: boolean;
  structure?: string;
  confirmedRoundRobin: boolean;
}) {
  return (
    <>
      <div className="intermission-section-heading">
        <h2>
          {confirmedRoundRobin
            ? 'Round-robin set records'
            : poolTitle(`${page.pool.division}:${page.pool.poolIndex}`, structure, 'heading')}
        </h2>
        <span className="intermission-set-count">
          {page.pool.complete} / {page.pool.total} sets complete
        </span>
      </div>
      {confirmedRoundRobin && <p>Confirmed places shown separately.</p>}
      <table className="intermission-standings">
        <thead>
          <tr>
            <th>Player</th>
            <th>Sets W–L</th>
            <th>Games ±</th>
            <th>{closed ? 'No result' : 'To play'}</th>
          </tr>
        </thead>
        <tbody>
          {page.players.map((player) => (
            <tr key={player.id}>
              <td>{player.name}</td>
              <td>
                {player.wins}–{player.losses}
              </td>
              <td>
                {player.differential > 0 ? '+' : ''}
                {player.differential}
              </td>
              <td>{player.remaining}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
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

function QualificationPage({
  page,
  entrants,
}: {
  page: Extract<ProgressPage, { kind: 'qualification' }>;
  entrants: ProgressData['entrants'];
}) {
  const names = new Map(entrants.map(({ id, name }) => [id, name]));
  return (
    <>
      <div className="intermission-section-heading">
        <h2>{finalsFieldLabel(page)} qualification</h2>
      </div>
      <table className="intermission-standings intermission-qualification">
        <thead>
          <tr>
            <th>Qualifying place</th>
            <th>Entrant or status</th>
          </tr>
        </thead>
        <tbody>
          {page.slots.map((slot) => (
            <tr key={`${slot.poolId}:${slot.place}`}>
              <td>{qualifierLabel(slot)}</td>
              <td>{qualifierDetail(slot, names) ?? 'Awaiting qualification'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
