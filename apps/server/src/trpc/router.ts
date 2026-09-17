import { router } from './trpc';
import { eventOpsRouter } from '../event-operations/router';
import { adminRouter } from './routers/admin';
import { meRouter } from './routers/me';
import { publicRouter } from './routers/public';

export const appRouter = router({
  public: publicRouter,
  eventOps: eventOpsRouter,
  me: meRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
