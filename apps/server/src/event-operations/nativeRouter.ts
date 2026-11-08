import type { Db } from '@smashclub/db';
import { StrengthSeedPolicy } from '../tournament/schemas';
import { rollingFinals } from '../tournament/qualifiers';
import { nativeEvent } from '../tournament/api';
import { receiptKey } from '../tournament/facts';
import { finalsToken } from '../tournament/operations';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { authedProcedure, router } from '../trpc/trpc';
import { requireOperator } from './service';
import { previewNativeBrackets } from './nativeBrackets';
const plan = z.object({ planId: z.uuid() });
const reviewed = plan.extend({ revisionToken: z.string().length(64) });
export const nativeBracketRouter = router({
  preview: authedProcedure
    .input(plan.extend({ seedPolicy: StrengthSeedPolicy.optional() }))
    .query(async ({ ctx, input }) => {
      await requireOperator(ctx.db, input.planId, ctx.user);
      const api = await nativeEvent(ctx, input.planId, false, input);
      return api ? api.previewFinals(input.seedPolicy) : previewLegacyFinals(ctx.db, input.planId);
    }),
  generate: authedProcedure
    .input(
      reviewed.extend({
        seedPolicy: StrengthSeedPolicy.optional(),
        requestId: z.uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (!api)
        throw new TRPCError({ code: 'CONFLICT', message: 'Lock the pools before drawing finals.' });
      const state = await api.state();
      const receipt = input.requestId
        ? state.receipts[receiptKey(ctx.user.id, input.requestId)]
        : undefined;
      if (!receipt && finalsToken(state, input.seedPolicy) !== input.revisionToken)
        throw new TRPCError({ code: 'CONFLICT', message: 'Preview finals again.' });
      if (!receipt && !input.seedPolicy && rollingFinals(state) && state.brackets.length)
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Finals already exist. Qualifiers resolve automatically; remove unplayed finals explicitly before creating a new draw.',
        });
      await api.execute({
        kind: 'drawFinals',
        revisionToken: input.revisionToken,
        replaceExisting: !input.seedPolicy && Boolean(state.brackets.length),
        seedPolicy: input.seedPolicy,
      });
      return { created: (await api.state()).brackets.length };
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

async function previewLegacyFinals(db: Db, planId: string) {
  const preview = await previewNativeBrackets(db, planId);
  const resetCallMatchIds: string[] = [];
  return {
    ...preview,
    resetAllowed: false,
    resetIssues: preview.replacing
      ? [
          ...preview.resetIssues,
          'This draw is stored in the older event system. Removal here requires a live draw.',
        ]
      : preview.resetIssues,
    resetCallMatchIds,
  };
}
