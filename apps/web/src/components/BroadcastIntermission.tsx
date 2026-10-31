import { useEffect, useMemo, useState } from 'react';
import {
  broadcastProgressPages,
  type ProgressData,
  type ProgressPage,
} from '../lib/broadcastProgress';
import { EventBracketLane } from './EventBracketLane';
import { NemesisMark } from './NemesisMark';
import { Button } from './ui/Button';
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
}: {
  data: ProgressData;
  seconds: number;
  announcement: string;
  controls: boolean;
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
  useEffect(() => {
    if (paused || reduced || pages.length < 2) return;
    const pageKeys = keys.split('|');
    const timer = window.setInterval(
      () =>
        setCurrent(
          (previous) => pageKeys[(Math.max(0, pageKeys.indexOf(previous)) + 1) % pageKeys.length]!,
        ),
      seconds * 1000,
    );
    return () => clearInterval(timer);
  }, [keys, seconds, paused, reduced, pages.length]);
  useEffect(() => {
    const pageKeys = keys.split('|');
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
      setCurrent(
        (previous) =>
          pageKeys[
            (Math.max(0, pageKeys.indexOf(previous)) + direction + pageKeys.length) %
              pageKeys.length
          ]!,
      );
      event.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [keys]);
  const page = pages[index]!;
  const labels = new Map(data.matches.map((match) => [match.id, match.label]));
  const next = (direction: number) =>
    setCurrent(pages[(index + direction + pages.length) % pages.length]!.key);
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
              : 'Tournament progress'}
        </span>
      </header>
      <main className="intermission-content" key={page.key}>
        {page.kind === 'pool' ? (
          <PoolPage page={page} />
        ) : page.kind === 'bracket' ? (
          <>
            <div className="intermission-section-heading">
              <h2>
                {page.bracket.division} ·{' '}
                {page.bracket.stage === 'main' ? 'Championship' : 'Consolation'}
                {page.lane.title ? ` · ${page.lane.title}` : ''}
              </h2>
              <span>
                Section {page.part} / {page.parts}
              </span>
            </div>
            {page.bracket.complete && page.bracket.winnerId && (
              <p>
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
                cardWidth={Math.max(250, Math.round(viewportWidth / 4))}
                roundTitles={page.roundTitles}
              />
            ) : (
              <p>
                {page.bracket.complete
                  ? 'No played sets in this bracket.'
                  : 'The draw has no published matches yet.'}
              </p>
            )}
          </>
        ) : (
          <div className="intermission-summary">
            <h2>
              {['complete', 'cancelled'].includes(data.plan.status)
                ? 'Recorded tournament results'
                : data.matches.length
                  ? 'Tournament progress'
                  : 'Waiting for the draw'}
            </h2>
            <p>
              {data.matches.filter((match) => match.status === 'complete').length} /{' '}
              {data.matches.length} sets complete
            </p>
            <p>
              Full event information and recorded results at {location.origin}/play/
              {encodeURIComponent(data.plan.id)}
            </p>
          </div>
        )}
      </main>
      <footer className="intermission-footer">
        <p>
          {announcement ||
            (['complete', 'cancelled'].includes(data.plan.status)
              ? 'Recorded tournament results'
              : 'Live records · final places depend on confirmed results')}
        </p>
        <span>
          Page {index + 1} / {pages.length}
          {reduced ? ' · manual pages' : paused ? ' · paused' : ''}
        </span>
        {controls && (
          <div className="intermission-controls">
            <Button onClick={() => next(-1)} disabled={pages.length < 2}>
              Previous page
            </Button>
            <Button onClick={() => next(1)} disabled={pages.length < 2}>
              Next page
            </Button>
            {!reduced && (
              <Button onClick={() => setPaused((value) => !value)}>
                {paused ? 'Resume rotation' : 'Pause rotation'}
              </Button>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}

function PoolPage({ page }: { page: Extract<ProgressPage, { kind: 'pool' }> }) {
  return (
    <>
      <div className="intermission-section-heading">
        <h2>
          {page.pool.division} · Pool {String.fromCharCode(65 + page.pool.poolIndex)}
        </h2>
        <span>
          {page.pool.complete} / {page.pool.total} sets complete · Section {page.part} /{' '}
          {page.parts}
        </span>
      </div>
      <p>Live standings for review. Pool order and final seeds are separate decisions.</p>
      <table className="intermission-standings">
        <thead>
          <tr>
            <th>Player</th>
            <th>Sets W–L</th>
            <th>Games ±</th>
            <th>To play</th>
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
