import { eventBroadcastPresentations, eventPlans, type Db } from '@smashclub/db';
import { broadcastPresentationModes, type BroadcastPresentationMode } from '@smashclub/shared';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { authedProcedure, type TrpcContext } from '../trpc/trpc';
import { requireOperator } from './access';
import { readPresentationLifecycle } from './presentationAccess';

type Presentation = { mode: BroadcastPresentationMode; revision: number };

export async function readBroadcastPresentation(db: Db, planId: string) {
  const [saved] = await db
    .select()
    .from(eventBroadcastPresentations)
    .where(eq(eventBroadcastPresentations.eventPlanId, planId));
  return saved;
}

export function operatorBroadcastPresentation(saved?: Presentation | null): Presentation {
  return { mode: saved?.mode ?? 'auto', revision: saved?.revision ?? 0 };
}

export function publicBroadcastPresentation(
  saved: Presentation | null | undefined,
  visible: boolean,
): { broadcastPresentationMode?: BroadcastPresentationMode } {
  return visible && saved ? { broadcastPresentationMode: saved.mode } : {};
}

const BroadcastPresentationInput = z.object({
  planId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  mode: z.enum(broadcastPresentationModes),
});

async function setBroadcastPresentation(
  ctx: TrpcContext & { user: NonNullable<TrpcContext['user']> },
  { planId, expectedRevision, mode }: z.output<typeof BroadcastPresentationInput>,
): Promise<Presentation> {
  return ctx.db.transaction(async (tx) => {
    // Serialize against other presentation writers and linked lifecycle/settings changes.
    const [plan] = await tx
      .select()
      .from(eventPlans)
      .where(eq(eventPlans.id, planId))
      .for('update');
    if (!plan || plan.deletedAt)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
    await requireOperator(tx, planId, ctx.user);
    const { open, published } = await readPresentationLifecycle(tx, plan, ctx.nativeRuntime);
    if (!open || !published)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The event must be open and published to switch its presentation.',
      });

    const saved = operatorBroadcastPresentation(await readBroadcastPresentation(tx, planId));
    if (saved.revision === expectedRevision + 1 && saved.mode === mode) return saved;
    if (saved.revision !== expectedRevision)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The event presentation changed. Review the current mode and choose again.',
      });
    if (saved.mode === mode) return saved;

    const next = { mode, revision: saved.revision + 1 };
    await tx
      .insert(eventBroadcastPresentations)
      .values({ eventPlanId: planId, ...next })
      .onConflictDoUpdate({ target: eventBroadcastPresentations.eventPlanId, set: next });
    return next;
  });
}

export const broadcastPresentationProcedure = authedProcedure
  .input(BroadcastPresentationInput)
  .mutation(({ ctx, input }) => setBroadcastPresentation(ctx, input));
