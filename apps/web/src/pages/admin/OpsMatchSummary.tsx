import { Button } from '../../components/ui/Button';
import type { trpc } from '../../lib/trpc';

type Match = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>['matches'][number];

export function OpsMatchSummary({
  matches,
  callable,
  filter,
  onSelect,
}: {
  matches: Match[];
  callable: Set<string>;
  filter: string;
  onSelect: (status: string) => void;
}) {
  return (
    <div className="ops-stats">
      {(['playing', 'ready', 'waiting', 'complete'] as const).map((status) => (
        <Button
          type="submit"
          variant="plain"
          key={status}
          className={`ops-stat ${filter === status ? 'selected' : ''}`}
          aria-pressed={filter === status}
          onClick={() => onSelect(status)}
        >
          <strong>
            {status === 'ready'
              ? callable.size
              : status === 'waiting'
                ? matches.filter(
                    (match) =>
                      match.status === 'blocked' ||
                      (match.status === 'ready' && !callable.has(match.id)),
                  ).length
                : matches.filter((match) => match.status === status).length}
          </strong>
          <span>
            {status === 'playing'
              ? 'Playing now'
              : status === 'ready'
                ? 'Ready to start'
                : status === 'waiting'
                  ? 'Waiting'
                  : 'Finished'}
          </span>
        </Button>
      ))}
    </div>
  );
}
