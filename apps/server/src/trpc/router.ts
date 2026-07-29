import { router } from './trpc';
import { adminRouter } from './routers/admin';
import { meRouter } from './routers/me';
import { publicRouter } from './routers/public';

export const appRouter = router({
  public: publicRouter,
  me: meRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
