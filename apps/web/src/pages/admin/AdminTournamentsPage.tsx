import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../../lib/trpc';
import type { TournamentListItem } from '../../lib/apiTypes';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useNow } from '../../lib/useNow';

/**
 * Default live-monitoring window. Deliberately bounded: the previous behaviour
 * inferred "live" from Challonge's sticky `underway` state and polled dead
 * brackets forever. An event running longer than this can simply be re-armed.
 */
const LIVE_HOURS = 6;

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AdminTournamentsPage() {
  const queryClient = useQueryClient();
  const tournaments = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => trpc.public.tournaments.query(),
  });
  const jobs = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => trpc.admin.jobs.query(),
    refetchInterval: 15_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tournaments'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] });
  };

  // One clock for the whole table, passed down: each row only needs it to tell
  // whether its live window has expired, and a timer per row would be waste.
  const now = useNow();

  return (
    <div>
      <RegisterForm onDone={invalidate} />

      <div className="section">
        <h2>Tournaments</h2>
        {tournaments.isPending && <p className="loading-text">Loading…</p>}
        {tournaments.isError && <p className="error-text">{tournaments.error.message}</p>}
        {tournaments.data && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Event date</th>
                  <th>Rookie</th>
                  <th>State</th>
                  <th>Sync</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tournaments.data.map((t) => (
                  <TournamentRow key={t.id} tournament={t} now={now} onChanged={invalidate} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <h2>Job log</h2>
        {jobs.isPending && <p className="loading-text">Loading…</p>}
        {jobs.isError && <p className="error-text">{jobs.error.message}</p>}
        {jobs.data && jobs.data.length === 0 && <p className="muted">No jobs yet.</p>}
        {jobs.data && jobs.data.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Tournament</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((job) => {
                  const tournament = tournaments.data?.find((t) => t.id === job.tournamentId);
                  const duration =
                    job.finishedAt != null
                      ? `${((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000).toFixed(1)}s`
                      : '…';
                  return (
                    <tr key={job.id}>
                      <td>
                        <code>{job.type}</code>
                      </td>
                      <td>{tournament?.name ?? '—'}</td>
                      <td>
                        <span
                          className={`chip ${
                            job.status === 'complete' ? 'chip-success' : job.status === 'failed' ? 'chip-danger' : 'chip-warning'
                          }`}
                        >
                          {job.status}
                        </span>
                      </td>
                      <td title={formatDateTime(job.startedAt)}>{timeAgo(job.startedAt)}</td>
                      <td>{duration}</td>
                      <td className="error-text">{job.error ?? ''}</td>
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

function RegisterForm({ onDone }: { onDone: () => void }) {
  const [slugOrUrl, setSlugOrUrl] = useState('');
  const [isRookie, setIsRookie] = useState(false);

  const register = useMutation({
    mutationFn: async () => {
      const { tournamentId } = await trpc.admin.registerTournament.mutate({ slugOrUrl, isRookie });
      await trpc.admin.syncNow.mutate({ tournamentId });
    },
    onSuccess: () => {
      setSlugOrUrl('');
      setIsRookie(false);
      onDone();
    },
  });

  return (
    <div className="card section">
      <h2>Register tournament</h2>
      <div className="admin-form-row">
        <input
          className="input"
          placeholder="Challonge slug or URL"
          value={slugOrUrl}
          onChange={(e) => setSlugOrUrl(e.target.value)}
        />
        <label className="checkbox-label">
          <input type="checkbox" checked={isRookie} onChange={(e) => setIsRookie(e.target.checked)} />
          Rookie bracket
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={slugOrUrl.trim() === '' || register.isPending}
          onClick={() => register.mutate()}
        >
          {register.isPending ? 'Registering…' : 'Register + sync'}
        </button>
      </div>
      {register.isError && <p className="error-text">{register.error.message}</p>}
    </div>
  );
}

function TournamentRow({
  tournament,
  now,
  onChanged,
}: {
  tournament: TournamentListItem;
  /** Ticking clock from the page; see lib/useNow.ts. */
  now: number;
  onChanged: () => void;
}) {
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState('');

  const sync = useMutation({
    mutationFn: () => trpc.admin.syncNow.mutate({ tournamentId: tournament.id }),
    onSuccess: onChanged,
  });
  // Opt-in metered sync. The default reads the free public bracket; the API is
  // only worth spending quota on for a tournament the club owns, since it is
  // the sole source of final placements.
  const syncApi = useMutation({
    mutationFn: () => trpc.admin.syncNow.mutate({ tournamentId: tournament.id, useApi: true }),
    onSuccess: onChanged,
  });
  const update = useMutation({
    mutationFn: (patch: { isRookie?: boolean; eventDate?: string | null }) =>
      trpc.admin.updateTournament.mutate({ tournamentId: tournament.id, ...patch }),
    onSuccess: () => {
      setEditingDate(false);
      onChanged();
    },
  });
  // Live monitoring is opt-in and time-boxed: it is never inferred from
  // Challonge's state, which stays "underway" on abandoned brackets forever.
  const setLive = useMutation({
    mutationFn: () => trpc.admin.setTournamentLive.mutate({ tournamentId: tournament.id, hours: LIVE_HOURS }),
    onSuccess: onChanged,
  });
  const endLive = useMutation({
    mutationFn: () => trpc.admin.endTournamentLive.mutate({ tournamentId: tournament.id }),
    onSuccess: onChanged,
  });

  const liveUntil = tournament.liveUntil ? new Date(tournament.liveUntil) : null;
  const isLive = liveUntil !== null && liveUntil.getTime() > now;

  const startEditDate = () => {
    if (tournament.eventDate) {
      // datetime-local wants "YYYY-MM-DDTHH:mm" in local time
      const d = new Date(tournament.eventDate);
      const pad = (n: number) => String(n).padStart(2, '0');
      setDateValue(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      );
    } else {
      setDateValue('');
    }
    setEditingDate(true);
  };

  const error = sync.error ?? syncApi.error ?? update.error ?? setLive.error ?? endLive.error;

  return (
    <tr>
      <td>
        <Link to="/tournaments/$slug" params={{ slug: tournament.slug }}>
          {tournament.name}
        </Link>
        {error && <div className="error-text">{error.message}</div>}
      </td>
      <td>
        {editingDate ? (
          <span className="date-edit">
            <input
              className="input"
              type="datetime-local"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({ eventDate: dateValue === '' ? null : new Date(dateValue).toISOString() })
              }
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-small"
              title="Clear the manual date — falls back to Challonge's date on next sync"
              disabled={update.isPending}
              onClick={() => update.mutate({ eventDate: null })}
            >
              Clear
            </button>
            <button type="button" className="btn btn-small" onClick={() => setEditingDate(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="date-edit">
            {formatDateTime(tournament.eventDate)}
            <button type="button" className="btn btn-small" onClick={startEditDate}>
              Edit
            </button>
          </span>
        )}
      </td>
      <td>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={tournament.isRookie}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ isRookie: e.target.checked })}
          />
          rookie
        </label>
      </td>
      <td>{tournament.challongeState ?? 'pending'}</td>
      <td>
        {tournament.syncState}
        {tournament.lastSyncedAt && <div className="muted">{timeAgo(tournament.lastSyncedAt)}</div>}
      </td>
      <td>
        <button
          type="button"
          className="btn btn-small"
          disabled={sync.isPending}
          title="Sync from the free public bracket. No API quota used."
          onClick={() => sync.mutate()}
        >
          {sync.isPending ? 'Syncing…' : 'Sync now'}
        </button>{' '}
        <button
          type="button"
          className="btn btn-small"
          disabled={syncApi.isPending}
          title="Sync via the Challonge API — SPENDS ~3 of the 500 requests/month allowance. Only useful for tournaments the club owns; it is the only way to get final placements."
          onClick={() => syncApi.mutate()}
        >
          {syncApi.isPending ? 'Syncing…' : 'Sync (API)'}
        </button>{' '}
        {isLive ? (
          <button
            type="button"
            className="btn btn-small"
            disabled={endLive.isPending}
            title={`Live until ${liveUntil!.toLocaleString()} — polling the public bracket every 60s`}
            onClick={() => endLive.mutate()}
          >
            {endLive.isPending ? 'Stopping…' : `Stop live (until ${formatClock(liveUntil!)})`}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small"
            disabled={setLive.isPending}
            title={`Poll this bracket every 60s for ${LIVE_HOURS}h, then stop automatically. Uses the public bracket, not the rate-limited API.`}
            onClick={() => setLive.mutate()}
          >
            {setLive.isPending ? 'Starting…' : `Go live (${LIVE_HOURS}h)`}
          </button>
        )}
      </td>
    </tr>
  );
}
