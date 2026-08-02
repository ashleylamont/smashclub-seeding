import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { isBracketAbandoned, isBracketOver } from '@smashclub/shared';
import { trpc } from '../lib/trpc';
import type { TournamentData, TournamentSet } from '../lib/apiTypes';
import { formatDate, formatDateTime, roundLabel, scoreCell, timeAgo } from '../lib/format';
import { challongeStateLabel, setStateLabel, syncStateLabel } from '../lib/labels';
import { useEventSource } from '../lib/useEventSource';
import { useNow } from '../lib/useNow';
import { InfoTip } from '../components/InfoTip';
import './Tournaments.css';

export function TournamentPage() {
  const { slug } = useParams({ from: '/tournaments/$slug' });
  const queryClient = useQueryClient();
  const now = useNow();

  const query = useQuery({
    queryKey: ['tournament', slug],
    queryFn: () => trpc.public.tournament.query({ slug }),
  });

  const isLive = isLiveNow(query.data ?? null, now);
  useEventSource(isLive && query.data ? `/api/live/${query.data.id}` : null, (type) => {
    if (type === 'set_updated' || type === 'sync_completed') {
      void queryClient.invalidateQueries({ queryKey: ['tournament', slug] });
    }
  });

  if (query.isPending) return <p className="loading-text">Loading tournament…</p>;
  if (query.isError) return <p className="error-text">Failed to load tournament: {query.error.message}</p>;
  if (query.data === null) return <p className="error-text">Tournament not found.</p>;

  return <TournamentDetail data={query.data} now={now} />;
}

/**
 * Live means an admin has an open monitoring window on this bracket — never
 * Challonge's sticky `underway`, and no longer `syncState === 'live'`, which
 * the sync pipeline stopped writing when liveness became `liveUntil`. The page
 * had been asking a question nothing answered, so nothing was ever live.
 */
function isLiveNow(data: TournamentData | null, now: number): boolean {
  return data?.liveUntil != null && new Date(data.liveUntil).getTime() > now;
}

function TournamentDetail({ data, now }: { data: TournamentData; now: number }) {
  const isLive = isLiveNow(data, now);
  // Over, not necessarily finished: a bracket abandoned mid-run is also done.
  const abandoned = isBracketAbandoned(data, now);
  const isComplete = isBracketOver(data, now);

  const standings = useMemo(() => {
    if (!isComplete) return [];
    return data.participants.filter((p) => p.finalRank != null);
  }, [data.participants, isComplete]);

  const recentSets = useMemo(
    () =>
      data.sets
        .filter((s) => s.state === 'complete' && s.completedAt != null)
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
        .slice(0, 8),
    [data.sets],
  );

  const bracket = challongeStateLabel(data.challongeState, { abandoned });
  const sync = syncStateLabel(data.syncState);

  return (
    <div>
      <div className="page-header">
        <h1>{data.name}</h1>
        <span className="tournament-tags">
          {isLive && <span className="live-badge">LIVE</span>}
          {data.isRookie && (
            <span className="chip chip-warning" title="A beginners' bracket — sets in it are weighted differently">
              rookie
            </span>
          )}
          <span className="chip" title={bracket.hint}>
            {bracket.label}
          </span>
        </span>
      </div>
      {/*
       * Two different states used to be printed raw, side by side, in the same
       * grey: Challonge's word for the bracket and ours for the pipeline. They
       * answer different questions — "has it been played" and "have we counted
       * it" — so they are labelled as such and the second explains itself.
       */}
      <p className="muted tournament-subtitle">
        <span>{formatDate(data.eventDate)}</span>
        <span className="tournament-sync">
          Results: {sync.label}
          {data.lastSyncedAt ? ` · checked ${timeAgo(data.lastSyncedAt)}` : ''}
          <InfoTip label="Results status">{sync.hint}</InfoTip>
        </span>
        {/* The recap covers the whole evening, so it is worth reaching for
            while a bracket is still running as well as after it finishes. */}
        <Link to="/recaps/$slug" params={{ slug: data.slug }} className="tournament-recap-link">
          {isComplete ? 'The night in review →' : 'Recap so far →'}
        </Link>
        {/* Venue mode is for the room's screen, so it is only offered while
            there is something left to watch. */}
        {!isComplete && (
          <Link
            to="/tournaments/$slug/live"
            params={{ slug: data.slug }}
            className="tournament-recap-link tournament-venue-link"
          >
            Venue mode →
          </Link>
        )}
      </p>

      {isLive && recentSets.length > 0 && (
        <div className="section card live-feed">
          <h3>
            <span className="live-badge">LIVE</span> Recent results
          </h3>
          <ul className="live-feed-list">
            {recentSets.map((set) => (
              <li key={set.id}>
                <SetLine set={set} />
                <span className="muted"> — {timeAgo(set.completedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {standings.length > 0 && (
        <div className="section">
          <h2>Standings</h2>
          {/* Three short columns fit any phone, so this one opts out of the
              minimum width that makes the sets table scroll. */}
          <div className="table-scroll">
            <table className="data-table table-narrow">
              <thead>
                <tr>
                  <th className="num">Place</th>
                  <th className="col-fill">Player</th>
                  <th className="num" title="The seed they entered the bracket on">
                    Seed
                  </th>
                </tr>
              </thead>
              <tbody>
                {standings.map((p) => (
                  <tr key={p.id}>
                    <td className="num">{p.finalRank}</td>
                    <td>
                      <ParticipantName name={p.name} playerId={p.playerId} />
                    </td>
                    <td className="num">{p.challongeSeed ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!isComplete && data.participants.length > 0 && (
        <div className="section">
          <h2>Participants ({data.participants.length})</h2>
          <div className="table-scroll">
            <table className="data-table table-narrow">
              <thead>
                <tr>
                  <th className="num" title="The seed they entered the bracket on">
                    Seed
                  </th>
                  <th className="col-fill">Player</th>
                </tr>
              </thead>
              <tbody>
                {[...data.participants]
                  .sort((a, b) => (a.challongeSeed ?? 1e9) - (b.challongeSeed ?? 1e9))
                  .map((p) => (
                    <tr key={p.id}>
                      <td className="num">{p.challongeSeed ?? '—'}</td>
                      <td>
                        <ParticipantName name={p.name} playerId={p.playerId} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section">
        <h2>Sets ({data.sets.length})</h2>
        {data.sets.length === 0 ? (
          <p className="muted">No sets yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table sets-table">
              <thead>
                <tr>
                  <th title="Winners rounds are W1, W2…; losers rounds are L1, L2…">Round</th>
                  <th title="Challonge's identifier for this set in the bracket">Set</th>
                  <th className="col-fill">Match</th>
                  <th>Score</th>
                  <th>Status</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {data.sets.map((set) => {
                  const state = setStateLabel(set.state);
                  return (
                    <tr key={set.id} className={set.excludedFromRatings ? 'set-excluded' : undefined}>
                      <td className="mono">{set.round != null ? roundLabel(set.round) : '—'}</td>
                      <td className="mono">{set.identifier ?? '—'}</td>
                      <td>
                        <SetLine set={set} />
                        {set.excludedFromRatings && (
                          <span
                            className="chip chip-danger excluded-chip"
                            title="Not counted towards ratings — a walkover, a disqualification, or an admin exclusion"
                          >
                            excluded
                          </span>
                        )}
                      </td>
                      <td className="mono">{scoreCell(set.scoresCsv)}</td>
                      <td title={state.hint}>{state.label}</td>
                      <td className="mono">{set.completedAt ? formatDateTime(set.completedAt) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ParticipantName({ name, playerId }: { name: string; playerId: string | null }) {
  if (!playerId) return <>{name}</>;
  return (
    <Link to="/players/$playerId" params={{ playerId }}>
      {name}
    </Link>
  );
}

function SetLine({ set }: { set: TournamentSet }) {
  const p1 = set.p1Name ?? 'TBD';
  const p2 = set.p2Name ?? 'TBD';
  return (
    <span className="set-line">
      <span className={set.winner === 1 ? 'set-winner' : undefined}>{p1}</span>
      <span className="muted"> vs </span>
      <span className={set.winner === 2 ? 'set-winner' : undefined}>{p2}</span>
    </span>
  );
}
