import { players } from '@smashclub/db';
import { publicEntrantNames } from './entrants';
import { dispatchDesk } from './dispatch';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { authedProcedure, publicProcedure, router, type TrpcContext } from '../trpc/trpc';
import { requireOperator } from '../event-operations/access';
import { Command, PoolGameCorrection } from './schemas';
import { reviewPoolGameCorrection } from './poolGameCorrection';
import { TournamentConflict } from './domain';
import { nativeEventHistory } from './history';

const plan = z.object({ planId: z.uuid() });
function runtime(ctx: TrpcContext) {
  if (!ctx.nativeRuntime)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The native live tournament runtime is unavailable.',
    });
  return ctx.nativeRuntime;
}
async function transport<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TournamentConflict)
      throw new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
    throw error;
  }
}

/** Direct command/cursor/recovery API for the standard native lifecycle. */
export const nativeLiveRouter = router({
  dispatchDesk: authedProcedure.input(plan).query(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    return transport(async () => {
      const state = await runtime(ctx).state(input.planId);
      const names = publicEntrantNames(await ctx.db.select().from(players), state.entrants);
      return dispatchDesk(state, names);
    });
  }),
  previewPoolGameCorrection: authedProcedure
    .input(plan.extend(PoolGameCorrection.shape))
    .query(async ({ ctx, input: { planId, ...score } }) => {
      await requireOperator(ctx.db, planId, ctx.user);
      return transport(async () => {
        const { match, revisionToken } = reviewPoolGameCorrection(
          await runtime(ctx).state(planId),
          score,
        );
        return { previousScore: [match.score1!, match.score2!] as const, revisionToken };
      });
    }),
  command: authedProcedure
    .input(plan.extend({ requestId: z.string().min(1).max(128), command: Command }))
    .mutation(({ ctx, input }) =>
      transport(async () => {
        if (input.command.kind === 'substituteDoublesMember')
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Use the reviewed doubles substitution workflow.',
          });
        const live = runtime(ctx);
        const response = await live.command(ctx.user, input.planId, input.requestId, input.command);
        if (['finalize', 'replaceResult'].includes(input.command.kind)) {
          await live.drainReactions();
          return {
            ...response,
            publicationStatus:
              (await live.snapshot(input.planId, true)).publication?.status ?? null,
          };
        }
        return response;
      }),
    ),
  snapshot: publicProcedure
    .input(plan.extend({ cursor: z.number().int().nonnegative().optional() }))
    .query(({ ctx, input }) =>
      transport(() => runtime(ctx).snapshot(input.planId, false, input.cursor)),
    ),
  overview: authedProcedure.input(plan).query(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    return transport(async () => ({
      ...(await runtime(ctx).snapshot(input.planId, true)),
      ratingIntents: await runtime(ctx).ratingStatus(input.planId),
    }));
  }),
  history: authedProcedure
    .input(
      plan.extend({
        cursor: z
          .object({ source: z.enum(['act', 'imported']), before: z.number().int().nonnegative() })
          .optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireOperator(ctx.db, input.planId, ctx.user);
      return transport(() =>
        nativeEventHistory(runtime(ctx), ctx.db, input.planId, input.cursor, input.limit),
      );
    }),
  recover: authedProcedure.input(plan).mutation(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    return transport(() => runtime(ctx).recoverPublication(input.planId));
  }),
});
