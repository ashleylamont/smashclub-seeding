import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@smashclub/server/router';

export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api/trpc' })],
});
