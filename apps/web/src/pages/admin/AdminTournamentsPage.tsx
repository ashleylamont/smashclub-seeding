import { Input } from '../../components/ui/Input';
import { Checkbox } from '../../components/ui/Checkbox';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
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
                  <th>Results</th>
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
                            job.status === 'complete'
                              ? 'chip-success'
                              : job.status === 'failed'
                                ? 'chip-danger'
                                : 'chip-warning'
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
  const [resultsMode, setResultsMode] = useState<'auto' | 'final_stage_only'>('auto');

  const register = useMutation({
    mutationFn: async () => {
      const { tournamentId } = await trpc.admin.registerTournament.mutate({
        slugOrUrl,
        isRookie,
        resultsMode,
      });
      await trpc.admin.syncNow.mutate({ tournamentId });
    },
    onSuccess: () => {
      setSlugOrUrl('');
      setIsRookie(false);
      setResultsMode('auto');
      onDone();
    },
    onError: onDone,
  });

  return (
    <div className="card section">
      <h2>Register tournament</h2>
      <div className="admin-form-row">
        <Input
          placeholder="Challonge slug or URL"
          value={slugOrUrl}
          onChange={(e) => setSlugOrUrl(e.target.value)}
        />
        <label className="checkbox-label">
          <Checkbox checked={isRookie} onCheckedChange={setIsRookie} />
          Rookie bracket
        </label>
        <label className="form-field">
          <span className="form-label">Results</span>
          <Select
            value={resultsMode}
            onValueChange={(selectedValue) => setResultsMode(selectedValue as typeof resultsMode)}
          >
            <SelectItem value="auto">Auto (pools + finals when present)</SelectItem>
            <SelectItem value="final_stage_only">Final stage only</SelectItem>
          </Select>
        </label>
        <Button
          variant="primary"
          type="button"
          disabled={slugOrUrl.trim() === '' || register.isPending}
          onClick={() => register.mutate()}
        >
          {register.isPending ? 'Registering…' : 'Register + sync'}
        </Button>
      </div>
      <p className="muted">
        Auto counts pools and finals when present. Use Final stage only when recorded groups were
        only used for setup.
      </p>
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
    mutationFn: (patch: {
      isRookie?: boolean;
      resultsMode?: 'auto' | 'final_stage_only';
      eventDate?: string | null;
    }) => trpc.admin.updateTournament.mutate({ tournamentId: tournament.id, ...patch }),
    onSuccess: () => {
      setEditingDate(false);
      onChanged();
    },
    // The mode is saved even if the following refresh fails.
    onError: onChanged,
  });
  // Live monitoring is opt-in and time-boxed: it is never inferred from
  // Challonge's state, which stays "underway" on abandoned brackets forever.
  const setLive = useMutation({
    mutationFn: () =>
      trpc.admin.setTournamentLive.mutate({ tournamentId: tournament.id, hours: LIVE_HOURS }),
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
        <Select
          aria-label={`Results mode for ${tournament.name}`}
          value={tournament.resultsMode}
          disabled={update.isPending}
          onValueChange={(selectedValue) =>
            update.mutate({ resultsMode: selectedValue as 'auto' | 'final_stage_only' })
          }
        >
          <SelectItem value="auto">Auto</SelectItem>
          <SelectItem value="final_stage_only">Final stage only</SelectItem>
        </Select>
      </td>
      <td>
        {editingDate ? (
          <span className="date-edit">
            <Input
              type="datetime-local"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
            />
            <Button
              size="small"
              type="button"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  eventDate: dateValue === '' ? null : new Date(dateValue).toISOString(),
                })
              }
            >
              Save
            </Button>
            <Button
              size="small"
              type="button"
              title="Clear the manual date — falls back to Challonge's date on next sync"
              disabled={update.isPending}
              onClick={() => update.mutate({ eventDate: null })}
            >
              Clear
            </Button>
            <Button size="small" type="button" onClick={() => setEditingDate(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <span className="date-edit">
            {formatDateTime(tournament.eventDate)}
            <Button size="small" type="button" onClick={startEditDate}>
              Edit
            </Button>
          </span>
        )}
      </td>
      <td>
        <label className="checkbox-label">
          <Checkbox
            checked={tournament.isRookie}
            disabled={update.isPending}
            onCheckedChange={(nextChecked) => update.mutate({ isRookie: nextChecked })}
          />
          rookie
        </label>
      </td>
      <td>{tournament.challongeState ?? 'pending'}</td>
      <td>
        {tournament.provider === 'native' ? 'Saved in Nemesis' : tournament.syncState}
        {tournament.lastSyncedAt && <div className="muted">{timeAgo(tournament.lastSyncedAt)}</div>}
      </td>
      <td>
        {tournament.provider === 'native' ? (
          <a href={`/events/${encodeURIComponent(tournament.slug)}`}>Nemesis event results →</a>
        ) : (
          <>
            <Button
              size="small"
              type="button"
              disabled={sync.isPending}
              title="Sync from the free public bracket. No API quota used."
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </Button>{' '}
            <Button
              size="small"
              type="button"
              disabled={syncApi.isPending}
              title="Sync via the Challonge API — SPENDS ~3 of the 500 requests/month allowance. Only useful for tournaments the club owns; it is the only way to get final placements."
              onClick={() => syncApi.mutate()}
            >
              {syncApi.isPending ? 'Syncing…' : 'Sync (API)'}
            </Button>{' '}
            {isLive ? (
              <Button
                size="small"
                type="button"
                disabled={endLive.isPending}
                title={`Live until ${liveUntil!.toLocaleString()} — polling the public bracket every 60s`}
                onClick={() => endLive.mutate()}
              >
                {endLive.isPending ? 'Stopping…' : `Stop live (until ${formatClock(liveUntil!)})`}
              </Button>
            ) : (
              <Button
                size="small"
                type="button"
                disabled={setLive.isPending}
                title={`Poll this bracket every 60s for ${LIVE_HOURS}h, then stop automatically. Uses the public bracket, not the rate-limited API.`}
                onClick={() => setLive.mutate()}
              >
                {setLive.isPending ? 'Starting…' : `Go live (${LIVE_HOURS}h)`}
              </Button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
