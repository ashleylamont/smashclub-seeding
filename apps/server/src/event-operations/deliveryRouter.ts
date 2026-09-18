import { z } from 'zod';
import { authedProcedure, router } from '../trpc/trpc';
import { deliverMatchScore, deliveryStatus, reconcileMatchDelivery } from './delivery';

/** Register as eventOps.delivery. Defaults remain read-only, including harnesses. */
export const eventDeliveryRouter = router({
  status: authedProcedure.input(z.object({ planId: z.uuid() })).query(({ ctx, input }) =>
    deliveryStatus(ctx.db, ctx.user, input.planId, { enabled: ctx.env.CHALLONGE_SCORE_WRITES ?? false, apiKey: ctx.env.CHALLONGE_API_KEY })),
  deliver: authedProcedure.input(z.object({ matchId: z.uuid(), expectedRevision: z.number().int().nonnegative() })).mutation(async ({ ctx, input }) => {
    const result = await deliverMatchScore(ctx.db, ctx.user, input, { enabled: ctx.env.CHALLONGE_SCORE_WRITES ?? false, apiKey: ctx.env.CHALLONGE_API_KEY });
    if (result.ok) ctx.recomputeTrigger.request();
    return result;
  }),
  reconcile: authedProcedure.input(z.object({ matchId: z.uuid(), expectedRevision: z.number().int().nonnegative() })).mutation(async ({ ctx, input }) => {
    const result = await reconcileMatchDelivery(ctx.db, ctx.user, input, { enabled: ctx.env.CHALLONGE_SCORE_WRITES ?? false, apiKey: ctx.env.CHALLONGE_API_KEY });
    if (result.status === 'verified') ctx.recomputeTrigger.request();
    return result;
  }),
});
