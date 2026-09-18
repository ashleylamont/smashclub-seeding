import { z } from 'zod';
import { authedProcedure, router } from '../trpc/trpc';
import { requireOperator } from './service';
import { previewNativeBrackets, generateNativeBrackets, resetNativeBrackets, finalizeNativeEvent } from './nativeBrackets';
const plan = z.object({ planId: z.uuid() });
const reviewed = plan.extend({ revisionToken: z.string().length(64) });
export const nativeBracketRouter = router({
  preview: authedProcedure.input(plan).query(async ({ ctx, input }) => { await requireOperator(ctx.db, input.planId, ctx.user); return previewNativeBrackets(ctx.db, input.planId); }),
  generate: authedProcedure.input(reviewed).mutation(({ ctx, input }) => generateNativeBrackets(ctx.db, ctx.user, input.planId, input.revisionToken)),
  reset: authedProcedure.input(reviewed).mutation(({ ctx, input }) => resetNativeBrackets(ctx.db, ctx.user, input.planId, input.revisionToken)),
  finalize: authedProcedure.input(plan).mutation(async ({ ctx, input }) => { const result = await finalizeNativeEvent(ctx.db, ctx.user, input.planId); ctx.recomputeTrigger.request(); return result; }),
});
