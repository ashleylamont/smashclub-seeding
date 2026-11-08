import { TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@smashclub/server/router';

/** Publication/auth failures must hide any cached public snapshot. */
export function eventUnavailable(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(error.data?.code ?? '')
  );
}

export function returnUntakenCallMatchIds(error: unknown): string[] {
  if (!(error instanceof TRPCClientError)) return [];
  const data = (error as TRPCClientError<AppRouter>).data;
  return data && 'returnUntakenCallMatchIds' in data ? data.returnUntakenCallMatchIds : [];
}
