import { useQuery } from '@tanstack/react-query';
import { trpc } from './trpc';

export type PublicEventNight = Awaited<ReturnType<typeof trpc.eventOps.publicEvents.query>>[number];

/**
 * Publication alone is not a start signal. Require open play and a scheduled
 * start within the last 24 hours, so prelocked future draws and forgotten open
 * nights cannot claim the homepage. Compare instants, not UTC calendar dates:
 * local evening events may cross midnight, including during daylight saving.
 * Older events remain reachable through the directory.
 */
export function liveEventNights(
  events: readonly PublicEventNight[],
  now: number,
): PublicEventNight[] {
  return events.filter((event) => {
    const start = Date.parse(event.eventDate);
    return (
      event.status === 'underway' && !event.drawPaused && start <= now && now < start + 86_400_000
    );
  });
}

/** Share discovery and refresh policy between the homepage and event directory. */
export function usePublicEventNights() {
  return useQuery({
    queryKey: ['publicEventNights'],
    queryFn: () => trpc.eventOps.publicEvents.query(),
    refetchInterval: 15_000,
    retry: false,
  });
}
