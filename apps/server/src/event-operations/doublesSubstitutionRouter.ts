import { z } from 'zod';
import { lockPlayerRows } from '../identity/playerIds';
import { TRPCError } from '@trpc/server';
import { authedProcedure, type TrpcContext } from '../trpc/trpc';
import { DoublesSubstitutionInput } from '../tournament/commands';
import { captureSubstitutionIdentity } from '../tournament/doublesSubstitutionIdentity';
import { reviewDoublesSubstitution } from '../tournament/doublesSubstitution';
import { nativeTransport } from '../tournament/api';
import { hash } from '../tournament/facts';
import { requireOperator } from './access';

async function substitutionState(ctx: TrpcContext, planId: string) {
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
      message: 'Substitutions are available for soft-locked native doubles events.',
    });
  return { runtime, state };
}

export const previewDoublesSubstitution = authedProcedure
  .input(DoublesSubstitutionInput.extend({ planId: z.uuid() }))
  .query(async ({ ctx, input: { planId, ...input } }) => {
    const { state } = await substitutionState(ctx, planId);
    const identity = await captureSubstitutionIdentity(ctx.db, state, input);
    const { entrant, pool, matches, ...review } = reviewDoublesSubstitution(state, {
      ...input,
      identity,
    });
    return {
      ...review,
      oldMembers: identity?.oldMemberNames ?? null,
      newMembers: identity?.newMemberNames ?? null,
      division: pool?.division ?? null,
      poolIndex: pool?.index ?? null,
      seed: entrant?.seed ?? null,
      affectedMatchCount: matches.length,
    };
  });

export const applyDoublesSubstitution = authedProcedure
  .input(
    DoublesSubstitutionInput.extend({
      planId: z.uuid(),
      requestId: z.string().min(1).max(128),
      revisionToken: z.string().length(64),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const { planId, requestId, ...change } = input;
    const { runtime } = await substitutionState(ctx, planId);
    const intent = { ...change, kind: 'substituteDoublesMember' as const };
    // Hold the same player-row lock as profile merge through the durable append.
    return ctx.db.transaction(async (tx) => {
      await lockPlayerRows(tx, [change.incomingPlayerId]);
      const state = await runtime.state(planId);
      const identity = await captureSubstitutionIdentity(tx, state, change);
      const { receipt } = await nativeTransport(() =>
        runtime.command(ctx.user, planId, requestId, { ...intent, identity }, hash(intent), tx),
      );
      return { applied: true as const, sequence: receipt.sequence };
    });
  });
