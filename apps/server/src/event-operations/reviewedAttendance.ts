import { TRPCError } from '@trpc/server';
import type { TrpcContext } from '../trpc/trpc';
import { requireOperator } from './access';

export async function reviewedAttendanceState(ctx: TrpcContext, planId: string, action: string) {
  await requireOperator(ctx.db, planId, ctx.user!);
  const runtime = ctx.nativeRuntime;
  if (!runtime)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Native live runtime is unavailable.',
    });
  // A preview must never transfer a draft into live ownership.
  const state = await runtime.state(planId);
  if (!state.baseline)
    throw new TRPCError({
      code: 'CONFLICT',
      message: `${action} are available for soft-locked native doubles events.`,
    });
  return { runtime, state };
}
