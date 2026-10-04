import { nativeEvent } from '../tournament/api';
import { finalsToken } from '../tournament/operations';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { authedProcedure, router } from '../trpc/trpc';
import { requireOperator } from './service';
import { previewNativeBrackets } from './nativeBrackets';
const plan = z.object({ planId: z.uuid() });
const reviewed = plan.extend({ revisionToken: z.string().length(64) });
export const nativeBracketRouter = router({
  preview: authedProcedure.input(plan).query(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    const api = await nativeEvent(ctx, input.planId, false, input);
    return api ? api.previewFinals() : previewNativeBrackets(ctx.db, input.planId);
  }),
  generate: authedProcedure.input(reviewed).mutation(async ({ ctx, input }) => {
    const api = await nativeEvent(ctx, input.planId, false, input);
    if (!api)
      throw new TRPCError({ code: 'CONFLICT', message: 'Lock the pools before drawing finals.' });
    const state = await api.state();
    if (finalsToken(state) !== input.revisionToken)
      throw new TRPCError({ code: 'CONFLICT', message: 'Preview finals again.' });
    await api.execute({
      kind: 'drawFinals',
      revisionToken: input.revisionToken,
      replaceExisting: Boolean(state.brackets.length),
    });
    return { created: 4 };
  }),
  reset: authedProcedure.input(reviewed).mutation(async ({ ctx, input }) => {
    const api = await nativeEvent(ctx, input.planId, false, input);
    if (!api) throw new TRPCError({ code: 'CONFLICT', message: 'No live finals exist.' });
    const removed = (await api.state()).brackets.length;
    await api.execute({ kind: 'resetFinals', revisionToken: input.revisionToken });
    return { removed };
  }),
  finalize: authedProcedure.input(plan).mutation(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    const api = await nativeEvent(ctx, input.planId, false, input);
    if (api) {
      const state = await api.state();
      if (state.lifecycle === 'finalized') return { alreadyFinalized: true };
      await api.execute({ kind: 'finalize' });
      await api.runtime.drainReactions();
      return { alreadyFinalized: false };
    }
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Lock and complete the event before finalizing.',
    });
  }),
});
