import { createAuthClient } from 'better-auth/react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from './trpc';

export const authClient = createAuthClient({ basePath: '/api/auth' });

export type Session = ReturnType<typeof authClient.useSession>['data'];

/** The database role, which updates even while an auth session stays open. */
export function useCurrentUser(session: Session) {
  return useQuery({
    queryKey: ['me', 'whoami', session?.user.id],
    queryFn: () => trpc.me.whoami.query(),
    enabled: !!session,
    refetchInterval: 30_000,
  });
}
