import { z } from 'zod';
import { adminProcedure, mergeRouters, router } from './trpc';
import { feedbackCursor, listFeedback } from '../feedback';
import { eventOpsRouter } from '../event-operations/router';
import { adminRouter } from './routers/admin';
import { meRouter } from './routers/me';
import { publicRouter } from './routers/public';

const adminFeedbackRouter = router({
  feedbackInbox: adminProcedure
    .input(z.object({ cursor: feedbackCursor.optional() }).optional())
    .query(({ ctx, input }) => listFeedback(ctx.db, input?.cursor)),
});

export const appRouter = router({
  public: publicRouter,
  eventOps: eventOpsRouter,
  me: meRouter,
  admin: mergeRouters(adminRouter, adminFeedbackRouter),
});

export type AppRouter = typeof appRouter;
