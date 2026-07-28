import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ basePath: '/api/auth' });

export type Session = ReturnType<typeof authClient.useSession>['data'];

/** The user's role ('admin' | 'user'); not part of the inferred session type. */
export function sessionRole(session: Session): string | undefined {
  return (session?.user as { role?: string } | undefined)?.role;
}
