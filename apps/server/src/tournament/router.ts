import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { authedProcedure, publicProcedure, router, type TrpcContext } from '../trpc/trpc';
import { requireOperator } from '../event-operations/access';
import { Command } from './schemas';
import { TournamentConflict } from './domain';

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
  command: authedProcedure
    .input(plan.extend({ requestId: z.string().min(1).max(128), command: Command }))
    .mutation(({ ctx, input }) =>
      transport(async () => {
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
  recover: authedProcedure.input(plan).mutation(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    return transport(() => runtime(ctx).recoverPublication(input.planId));
  }),
});
