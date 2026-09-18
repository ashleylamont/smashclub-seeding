import { z } from 'zod';
import { authedProcedure, router } from '../trpc/trpc';
import { refreshEventSources } from './sourceRefresh';

/** Parent binds this router at eventOps.sources. */
export const sourceRefreshRouter = router({
  refresh: authedProcedure.input(z.object({ planId: z.string().uuid() })).mutation(({ ctx, input }) =>
    refreshEventSources(ctx.db, ctx.challonge, ctx.user, input.planId, { recompute: ctx.recomputeTrigger }),
  ),
});
