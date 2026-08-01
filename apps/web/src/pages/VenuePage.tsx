import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import type { TournamentData, TournamentParticipant, TournamentSet } from '../lib/apiTypes';
import { orientScore, roundLabel } from '../lib/format';
import { useEventSource } from '../lib/useEventSource';
import './Venue.css';

/**
 * Venue mode: the club night on a projector.
 *
 * Built for a screen nobody is sitting in front of — big type, no app chrome,
 * and it must never go static, because a frozen screen in the corner of a room
 * reads as broken. Everything comes from the same tournament query the normal
 * page uses; what differs is how an update is treated. A set finishing is an
 * *event* here rather than a table row that quietly changes, so completions are
 * detected by diffing against what was last on screen and announced.
 *
 * Players are shown under their public alias and company code — the same names
 * the leaderboard publishes — since this is a screen in a room that may include
 * guests.
 */
export function VenuePage() {
  const { slug } = useParams({ from: '/tournaments/$slug/live' });
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['tournament', slug],
    queryFn: () => trpc.public.tournament.query({ slug }),
    // A projector left running all evening should recover on its own if an SSE
    // event is ever missed.
    refetchInterval: 30_000,
  });

  useEventSource(query.data ? `/api/live/${query.data.id}` : null, (type) => {
    if (type === 'set_updated' || type === 'sync_completed') {
      void queryClient.invalidateQueries({ queryKey: ['tournament', slug] });
    }
  });

  // The app shell is hidden while this route is mounted; venue mode is the
  // whole screen, and a nav bar above it would be dead weight on a projector.
  useEffect(() => {
    document.body.dataset.venue = 'true';
    return () => {
      delete document.body.dataset.venue;
    };
  }, []);

  if (query.isPending) return <div className="venue venue-message">Loading…</div>;
  if (query.isError) return <div className="venue venue-message">Cannot reach the bracket.</div>;
  if (query.data == null) return <div className="venue venue-message">Tournament not found.</div>;

  return <Venue data={query.data} />;
}

/** A completed set the screen has not announced yet. */
interface Announcement {
  set: TournamentSet;
  winner: TournamentParticipant | null;
  loser: TournamentParticipant | null;
  upset: boolean;
}

const TAKEOVER_MS = 6500;
const IDLE_ROTATE_MS = 7000;

function Venue({ data }: { data: TournamentData }) {
  const byId = useMemo(
    () => new Map(data.participants.map((p) => [p.id, p])),
    [data.participants],
  );

  const sideOf = useCallback(
    (set: TournamentSet, side: 1 | 2): TournamentParticipant | null => {
      const id = side === 1 ? set.p1ParticipantId : set.p2ParticipantId;
      return id ? (byId.get(id) ?? null) : null;
    },
    [byId],
  );

  const completed = useMemo(
    () =>
      data.sets
        .filter((s) => s.state === 'complete' && s.winner != null && s.completedAt != null)
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
    [data.sets],
  );

  const open = useMemo(
    () => data.sets.filter((s) => s.state === 'open' && s.p1ParticipantId && s.p2ParticipantId),
    [data.sets],
  );

  const announcement = useSetAnnouncements(completed, sideOf);

  /*
   * Finals mode. The last round of a bracket is its biggest, so once nothing
   * below it is left to play the screen belongs to the final. Derived from the
   * bracket rather than a flag, so it needs no admin action on the night.
   */
  const finalRound = useMemo(
    () => data.sets.reduce((max, s) => Math.max(max, s.round ?? 0), 0),
    [data.sets],
  );
  const remaining = useMemo(() => data.sets.filter((s) => s.state !== 'complete'), [data.sets]);
  const inFinals =
    finalRound > 0 && remaining.length > 0 && remaining.every((s) => (s.round ?? 0) === finalRound);

  const setsDone = completed.length;
  const setsTotal = data.sets.length;
  const isComplete = data.challongeState === 'complete';

  return (
    <div className={`venue${inFinals ? ' venue-finals' : ''}`}>
      <header className="venue-header">
        <div className="venue-title">
          <span className={`venue-live${isComplete ? ' venue-live-done' : ''}`}>
            <span className="venue-live-dot" aria-hidden="true" />
            {isComplete ? 'FINISHED' : 'LIVE'}
          </span>
          <h1>{data.name}</h1>
        </div>
        <div className="venue-progress">
          <span className="venue-progress-count">
            {setsDone}
            <span className="venue-progress-total">/{setsTotal}</span>
          </span>
          <span className="venue-progress-label">sets played</span>
          <div className="venue-meter">
            <div
              className="venue-meter-fill"
              style={{ width: `${setsTotal === 0 ? 0 : (setsDone / setsTotal) * 100}%` }}
            />
          </div>
        </div>
      </header>

      {inFinals && (
        <p className="venue-finals-banner">
          {remaining.length > 1 ? 'Bracket reset — it all comes down to this' : 'Grand finals'}
        </p>
      )}

      <div className="venue-body">
        <section className="venue-panel venue-now">
          <h2>{inFinals ? 'The final' : 'Now playing'}</h2>
          {open.length === 0 ? (
            <IdlePanel data={data} completed={completed} isComplete={isComplete} byId={byId} />
          ) : (
            <ul className="venue-match-list">
              {open.slice(0, 4).map((set) => (
                <li key={set.id} className="venue-match">
                  <span className="venue-match-round">
                    {set.round != null ? roundLabel(set.round) : '—'}
                  </span>
                  <span className="venue-match-players">
                    <VenuePlayer participant={sideOf(set, 1)} />
                    <span className="venue-vs">vs</span>
                    <VenuePlayer participant={sideOf(set, 2)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="venue-panel venue-results">
          <h2>Results</h2>
          {completed.length === 0 ? (
            <p className="venue-empty">No sets finished yet.</p>
          ) : (
            <ul className="venue-result-list">
              {completed.slice(0, 9).map((set) => {
                const winner = sideOf(set, set.winner === 1 ? 1 : 2);
                const loser = sideOf(set, set.winner === 1 ? 2 : 1);
                return (
                  <li key={set.id} className="venue-result">
                    <span className="venue-result-winner">{winner?.name ?? 'TBD'}</span>
                    <span className="venue-result-score">{orientScore(set.scoresCsv, set.winner) ?? ''}</span>
                    <span className="venue-result-loser">{loser?.name ?? 'TBD'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <footer className="venue-footer">
        <span>{data.participants.length} entrants</span>
        <span>
          {remaining.length} {remaining.length === 1 ? 'set' : 'sets'} to come
        </span>
        <span className="venue-footer-links">
          <FullscreenButton />
          <Link to="/recaps/$slug" params={{ slug: data.slug }} className="venue-footer-link">
            Recap
          </Link>
          <Link to="/tournaments/$slug" params={{ slug: data.slug }} className="venue-footer-link">
            Exit
          </Link>
        </span>
      </footer>

      {announcement && <Takeover announcement={announcement} />}
    </div>
  );
}

/**
 * What the main panel shows when no set is underway.
 *
 * A projector that sits on "waiting…" for ten minutes looks broken, so the
 * quiet stretches between calls rotate through the night's own numbers instead
 * of holding one dead line of text.
 */
function IdlePanel({
  data,
  completed,
  isComplete,
  byId,
}: {
  data: TournamentData;
  completed: TournamentSet[];
  isComplete: boolean;
  byId: ReadonlyMap<string, TournamentParticipant>;
}) {
  const cards = useMemo(() => {
    const items: Array<{ label: string; value: string }> = [];

    const wins = new Map<string, number>();
    for (const set of completed) {
      const id = set.winner === 1 ? set.p1ParticipantId : set.p2ParticipantId;
      if (id) wins.set(id, (wins.get(id) ?? 0) + 1);
    }
    const best = [...wins.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      items.push({ label: 'Most sets won tonight', value: `${byId.get(best[0])?.name ?? '—'} — ${best[1]}` });
    }

    // Sets decided by a single game. Read off the oriented score so a walkover
    // (which has no readable scoreline) never counts as a close one.
    const decided = completed.filter((s) => {
      const oriented = orientScore(s.scoresCsv, s.winner);
      const match = oriented?.match(/^(\d+)-(\d+)$/);
      return match != null && Number(match[1]) - Number(match[2]) === 1;
    });
    if (decided.length > 0) {
      items.push({ label: 'Sets that went the distance', value: String(decided.length) });
    }

    items.push({ label: 'Entrants', value: String(data.participants.length) });
    items.push({ label: 'Sets played', value: String(completed.length) });
    return items;
  }, [completed, data.participants.length, byId]);

  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (cards.length <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % cards.length), IDLE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [cards.length]);

  if (isComplete) return <p className="venue-empty">That’s the night.</p>;
  const card = cards[index % cards.length];
  if (!card) return <p className="venue-empty">Waiting on the next call…</p>;

  return (
    <div className="venue-idle">
      <p className="venue-idle-eyebrow">Waiting on the next call</p>
      <p className="venue-idle-label">{card.label}</p>
      <p className="venue-idle-value" key={`${card.label}-${index}`}>
        {card.value}
      </p>
    </div>
  );
}

/**
 * Watches the completed-set list and yields each newly finished set once, so
 * the screen can announce it.
 *
 * The first pass is deliberately silent: a projector switched on mid-event
 * would otherwise fire a queue of takeovers for sets that finished an hour ago.
 * Only sets that complete while the screen is watching get announced.
 */
function useSetAnnouncements(
  completed: TournamentSet[],
  sideOf: (set: TournamentSet, side: 1 | 2) => TournamentParticipant | null,
): Announcement | null {
  const seen = useRef<Set<string> | null>(null);
  const [queue, setQueue] = useState<Announcement[]>([]);

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(completed.map((s) => s.id));
      return;
    }
    const fresh = completed.filter((s) => !seen.current!.has(s.id));
    if (fresh.length === 0) return;
    for (const set of fresh) seen.current.add(set.id);

    // Oldest first, so two sets reported together play in the order they were
    // actually finished.
    const additions = [...fresh]
      .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
      .map((set) => {
        const winner = sideOf(set, set.winner === 1 ? 1 : 2);
        const loser = sideOf(set, set.winner === 1 ? 2 : 1);
        const upset =
          winner?.challongeSeed != null &&
          loser?.challongeSeed != null &&
          winner.challongeSeed > loser.challongeSeed;
        return { set, winner, loser, upset };
      });
    setQueue((current) => [...current, ...additions]);
  }, [completed, sideOf]);

  // One at a time, each for a fixed beat, so a burst of results queues rather
  // than overwriting itself.
  useEffect(() => {
    if (queue.length === 0) return;
    const timer = setTimeout(() => setQueue((current) => current.slice(1)), TAKEOVER_MS);
    return () => clearTimeout(timer);
  }, [queue]);

  return queue[0] ?? null;
}

function Takeover({ announcement }: { announcement: Announcement }) {
  const { set, winner, loser, upset } = announcement;
  const score = orientScore(set.scoresCsv, set.winner);
  return (
    // aria-live so the announcement is not purely visual, even though the
    // audience is mostly a room looking at a projector.
    <div className={`venue-takeover${upset ? ' venue-takeover-upset' : ''}`} role="status" aria-live="polite">
      <div className="venue-takeover-inner" key={set.id}>
        <p className="venue-takeover-kind">{upset ? 'UPSET' : 'WINNER'}</p>
        {/* The space before the company code is load-bearing: without it the
            accessible name runs the two together ("Young LATL"). */}
        <p className="venue-takeover-name">
          {winner?.name ?? 'TBD'}
          {winner?.companyCode && <span className="venue-takeover-company"> {winner.companyCode}</span>}
        </p>
        <p className="venue-takeover-detail">
          {score && <span className="venue-takeover-score">{score}</span>}
          <span>
            over {loser?.name ?? 'TBD'}
            {upset && winner?.challongeSeed != null && loser?.challongeSeed != null && (
              <span className="venue-takeover-seeds">
                {' '}
                — seed {winner.challongeSeed} over {loser.challongeSeed}
              </span>
            )}
          </span>
        </p>
      </div>
    </div>
  );
}

function VenuePlayer({ participant }: { participant: TournamentParticipant | null }) {
  return (
    <span className="venue-player">
      <span className="venue-player-name">{participant?.name ?? 'TBD'}</span>
      <span className="venue-player-meta">
        {participant?.companyCode && <span className="venue-player-company">{participant.companyCode}</span>}
        {participant?.challongeSeed != null && (
          <span className="venue-player-seed">seed {participant.challongeSeed}</span>
        )}
      </span>
    </span>
  );
}

/**
 * Fullscreen is a user gesture away and cannot be requested on load, so it gets
 * a button. Hidden entirely where the API is unavailable rather than offering a
 * control that does nothing.
 */
function FullscreenButton() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onChange = (): void => setActive(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (typeof document === 'undefined' || !document.documentElement.requestFullscreen) return null;

  const toggle = async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // A browser that refuses the request just leaves the screen as it is.
    }
  };

  return (
    <button type="button" className="venue-footer-link venue-fullscreen" onClick={() => void toggle()}>
      {active ? 'Exit fullscreen' : 'Fullscreen'}
    </button>
  );
}
