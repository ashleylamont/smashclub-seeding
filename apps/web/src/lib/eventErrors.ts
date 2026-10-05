import { TRPCClientError } from '@trpc/client';

/** Publication/auth failures must hide any cached public snapshot. */
export function eventUnavailable(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(error.data?.code ?? '')
  );
}
