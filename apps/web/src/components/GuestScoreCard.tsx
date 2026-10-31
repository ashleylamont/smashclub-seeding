import { useQueryClient } from '@tanstack/react-query';
import { EventScoreCard } from './EventScoreCard';
import type { GuestSession } from '../lib/guestReporting';
import { trpc } from '../lib/trpc';
import type { ComponentProps } from 'react';
export type { GuestMatch } from './EventScoreCard';

/** Compatibility adapter for callers with a venue guest pass. */
export function GuestScoreCard({
  planId,
  session,
  ...props
}: Omit<ComponentProps<typeof EventScoreCard>, 'enabled' | 'onSubmit'> & {
  planId: string;
  session: GuestSession | null;
}) {
  const cache = useQueryClient();
  return (
    <EventScoreCard
      {...props}
      enabled={Boolean(session)}
      onSubmit={async (input) => {
        if (!session) throw new Error('Scan a guest reporting QR to report a score.');
        const result = await trpc.eventOps.guests.submit.mutate({
          planId,
          sessionToken: session.sessionToken,
          matchId: props.match.id,
          ...input,
        });
        await Promise.all([
          cache.invalidateQueries({ queryKey: ['guestMatches', planId] }),
          cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
        ]);
        return result;
      }}
    />
  );
}
