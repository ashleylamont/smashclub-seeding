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
    enabled: Boolean(session),
    refetchInterval: 30_000,
  });
}

export function useSignInOptions() {
  return useQuery({
    queryKey: ['auth-options'],
    retry: false,
    queryFn: async (): Promise<{ credentials: boolean; providers: string[] }> => {
      const response = await fetch('/api/auth-options');
      if (!response.ok) throw new Error('Sign-in is temporarily unavailable. Please try again.');
      return response.json();
    },
  });
}
