import type { trpc } from './trpc';

type DeskMatch = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>['matches'][number];
export function filterDeskMatches(
  all: DeskMatch[],
  available: DeskMatch[],
  callable: Set<string>,
  {
    focusedMatchId,
    filter,
    division,
    poolFilter,
    search,
  }: {
    focusedMatchId: string | null;
    filter: string;
    division: string;
    poolFilter: string;
    search: string;
  },
) {
  return focusedMatchId
    ? all.filter((match) => match.id === focusedMatchId)
    : (filter === 'ready' ? available : all).filter(
        (match) =>
          (division === 'all' || match.division === division) &&
          (filter === 'all' ||
            (filter === 'active'
              ? match.status !== 'complete'
              : filter === 'waiting'
                ? match.status === 'blocked' ||
                  (match.status === 'ready' && !callable.has(match.id))
                : match.status === filter)) &&
          (poolFilter === 'all' ||
            (match.stage === 'group' && `${match.division}:${match.poolIndex}` === poolFilter)) &&
          `${match.player1Name} ${match.player2Name} ${match.label}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      );
}
