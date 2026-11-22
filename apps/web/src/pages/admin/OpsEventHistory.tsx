import { useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { EmptyState, LoadingState, Notice } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Input';
import { Select, SelectItem } from '../../components/ui/Select';
import { trpc } from '../../lib/trpc';
import { useOnlineStatus } from '../../lib/useOnlineStatus';
import './OpsEventHistory.css';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type History = Awaited<ReturnType<typeof trpc.eventOps.live.history.query>>;
type Entry = History['entries'][number];
const categories = [
  ['all', 'All changes'],
  ['scores', 'Scores and reviews'],
  ['matches', 'Match progress'],
  ['players', 'Attendance and players'],
  ['draw', 'Pools and draw'],
  ['settings', 'Settings and stations'],
  ['results', 'Results and publication'],
  ['broadcast', 'Announcements and prizes'],
] as const;

export function OpsEventHistory({
  data,
  active,
  onMatch,
  attendanceOnly = false,
}: {
  data: Overview;
  active: boolean;
  onMatch: (id: string) => void;
  attendanceOnly?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const titleId = useId();
  const online = useOnlineStatus();
  const closed = data.plan.status === 'complete' || data.plan.status === 'cancelled';
  const title = attendanceOnly ? 'Attendance history' : 'Event history';
  const kind = attendanceOnly ? 'attendance changes' : 'changes';
  const history = useInfiniteQuery({
    queryKey: ['eventOps', data.plan.id, 'history'],
    initialPageParam: undefined as History['nextCursor'] | undefined,
    queryFn: ({ pageParam }) =>
      trpc.eventOps.live.history.query({ planId: data.plan.id, cursor: pageParam ?? undefined }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: active && Boolean(data.plan.liveOwned),
    refetchInterval: active ? 5000 : false,
    retry: false,
  });
  const loaded = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const entries = attendanceOnly ? loaded.filter((entry) => entry.category === 'players') : loaded;
  const filtered = entries.filter(
    (entry) =>
      (category === 'all' || entry.category === category) &&
      `${entry.title} ${entry.summary} ${entry.actor} ${entry.eventName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  if (attendanceOnly) filtered.reverse();
  const scope = history.hasNextPage || history.isError || !online ? 'loaded' : 'recorded';
  return (
    <section className="card ops-history" aria-labelledby={titleId}>
      <div className="ops-history-heading">
        <h3 id={titleId}>{title}</h3>
        {data.plan.liveOwned && history.data && (
          <Button
            type="button"
            size="small"
            disabled={history.isFetching}
            onClick={() => void history.refetch()}
          >
            Refresh history
          </Button>
        )}
      </div>
      {!data.plan.liveOwned &&
        (closed ? (
          <EmptyState title="No live history was recorded" />
        ) : (
          <EmptyState title="Live history has not started">
            Native events begin recording their live history when pools are locked or a TO starts
            play or records the first result.
          </EmptyState>
        ))}
      {data.plan.liveOwned &&
        history.isPending &&
        (online ? (
          <LoadingState>Loading {title.toLowerCase()}…</LoadingState>
        ) : (
          <p role="status">Waiting for a connection to load {title.toLowerCase()}…</p>
        ))}
      {data.plan.liveOwned && history.isError && (
        <Notice tone="danger">
          {history.isFetchNextPageError
            ? 'Could not load older changes.'
            : history.data
              ? 'Could not refresh history.'
              : `Could not load ${title.toLowerCase()}.`}{' '}
          {history.error.message}{' '}
          <Button
            type="button"
            size="small"
            onClick={() =>
              void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())
            }
          >
            Retry history
          </Button>
        </Notice>
      )}
      {data.plan.liveOwned && history.data && (
        <>
          {(entries.length > 0 || history.hasNextPage) && (
            <div className="ops-history-filters">
              {!attendanceOnly && (
                <label>
                  Change type
                  <Select value={category} onValueChange={setCategory}>
                    {categories.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
              )}
              <label>
                Search loaded history
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={attendanceOnly ? 'Player or organiser' : 'Player, match or change'}
                />
              </label>
            </div>
          )}
          {entries.length > 0 && (
            <p className="muted">
              {filtered.length} of {entries.length} {scope} {kind} shown.{' '}
              {attendanceOnly ? 'Earliest first.' : 'Newest first.'}{' '}
              {history.hasNextPage && 'Load older changes to search further back.'}
            </p>
          )}
          <ol
            className="ops-history-list"
            aria-label={attendanceOnly ? 'Recorded attendance changes' : 'Recorded event changes'}
          >
            {filtered.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                canOpenMatch={
                  !attendanceOnly && data.matches.some((match) => match.id === entry.matchId)
                }
                onMatch={onMatch}
              />
            ))}
          </ol>
          {!filtered.length && (
            <p>
              {entries.length > 0
                ? 'No changes match this view.'
                : scope === 'loaded'
                  ? `No ${kind} in the loaded history.`
                  : `No ${attendanceOnly ? kind : 'event changes'} have been recorded.`}
            </p>
          )}
          {history.hasNextPage && (
            <Button
              type="button"
              disabled={history.isFetching}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? 'Loading older changes…' : 'Load older changes'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function HistoryRow({
  entry,
  canOpenMatch,
  onMatch,
}: {
  entry: Entry;
  canOpenMatch: boolean;
  onMatch: (id: string) => void;
}) {
  return (
    <li className="ops-history-entry">
      <div className="ops-history-meta">
        <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
        <span>
          {entry.actor} ·{' '}
          {entry.source === 'imported'
            ? 'Imported audit'
            : entry.source === 'operator'
              ? 'TO / admin'
              : entry.source}
        </span>
      </div>
      <h4>{entry.title}</h4>
      <p>{entry.summary}</p>
      {entry.matchId && canOpenMatch && (
        <Button type="button" size="small" onClick={() => onMatch(entry.matchId!)}>
          Open match
        </Button>
      )}
      <Disclosure title="View recorded details">
        <p className="muted">
          {entry.eventName} · {entry.id}
          {entry.version !== null && ` · stream version ${entry.version}`}
        </p>
        {entry.source === 'imported' && (
          <p>This record predates the live event stream. It retains the original audit evidence.</p>
        )}
        <pre className="ops-history-details">{JSON.stringify(entry.details, null, 2)}</pre>
      </Disclosure>
    </li>
  );
}
