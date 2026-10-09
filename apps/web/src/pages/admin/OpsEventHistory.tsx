import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { EmptyState, LoadingState, Notice } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Input';
import { Select, SelectItem } from '../../components/ui/Select';
import { trpc } from '../../lib/trpc';
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
}: {
  data: Overview;
  active: boolean;
  onMatch: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
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
  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const filtered = entries.filter(
    (entry) =>
      (category === 'all' || entry.category === category) &&
      `${entry.title} ${entry.summary} ${entry.actor} ${entry.eventName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section className="card ops-history" aria-labelledby="event-history-title">
      <div className="ops-history-heading">
        <div>
          <h3 id="event-history-title">Event history</h3>
          <p className="muted">
            Who changed what, and when. Recorded events remain available after the event closes.
          </p>
        </div>
        {data.plan.liveOwned && (
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
      {!data.plan.liveOwned ? (
        <EmptyState title="Live history has not started">
          Native events begin recording their live history when pools are locked or a TO starts play
          or records the first result.
        </EmptyState>
      ) : (
        <>
          <div className="ops-history-filters">
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
            <label>
              Search loaded history
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Player, match, organiser or change"
              />
            </label>
          </div>
          {history.isPending && <LoadingState>Loading event history…</LoadingState>}
          {history.isError && (
            <Notice tone="danger">
              Could not load event history. {history.error.message}{' '}
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
          <p className="muted">
            {filtered.length} of {entries.length} loaded changes shown. Newest first. Filters apply
            to loaded entries; load older changes to search further back.
          </p>
          <ol className="ops-history-list" aria-label="Recorded event changes">
            {filtered.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                canOpenMatch={data.matches.some((match) => match.id === entry.matchId)}
                onMatch={onMatch}
              />
            ))}
          </ol>
          {!history.isPending && !history.isError && !filtered.length && (
            <p>No changes match this view.</p>
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
