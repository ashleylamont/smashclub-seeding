import { queryOptions } from '@tanstack/react-query';
import { eventUnavailable } from './eventErrors';
import { trpc } from './trpc';

async function readPublicArchive<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    // Cache the unavailable result. A thrown error retains the last successful
    // response, which could resurface during a later temporary failure.
    if (eventUnavailable(error)) return null;
    throw error;
  }
}

export const publicTournamentsQuery = queryOptions({
  queryKey: ['tournaments'],
  queryFn: () => readPublicArchive(() => trpc.public.tournaments.query()),
});

export function publicTournamentQuery(slug: string) {
  return queryOptions({
    queryKey: ['tournament', slug],
    queryFn: () => readPublicArchive(() => trpc.public.tournament.query({ slug })),
  });
}

export function publicEventOverviewQuery(slug: string) {
  return queryOptions({
    queryKey: ['eventOverview', slug],
    queryFn: () => readPublicArchive(() => trpc.public.eventOverview.query({ slug })),
  });
}
