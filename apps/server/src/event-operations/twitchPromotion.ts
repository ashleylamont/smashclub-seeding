import {
  eventOperationSettings,
  eventPlans,
  eventTwitchPromotions,
  nativeLiveHandoffs,
  type Db,
} from '@smashclub/db';
import { twitchChannel } from '@smashclub/shared';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { TrpcContext } from '../trpc/trpc';
import type { TournamentState } from '../tournament/schemas';
import { requireOperator } from './access';

type SavedTwitch = Pick<
  typeof eventTwitchPromotions.$inferSelect,
  'channel' | 'expiresAt' | 'revision'
>;
type TwitchPromotion = { channel: string; expiresAt: string };

export async function readTwitchPromotion(db: Db, planId: string) {
  const [saved] = await db
    .select()
    .from(eventTwitchPromotions)
    .where(eq(eventTwitchPromotions.eventPlanId, planId));
  return saved;
}

function savedPromotion(saved: SavedTwitch | null | undefined) {
  return saved?.channel && saved.expiresAt
    ? { channel: saved.channel, expiresAt: saved.expiresAt.toISOString() }
    : null;
}

export function publicTwitchPromotion(
  saved: SavedTwitch | null | undefined,
  visible: boolean,
  now = Date.now(),
): { twitchPromotion?: TwitchPromotion } {
  if (!visible || !saved?.expiresAt || saved.expiresAt.getTime() <= now) return {};
  const twitchPromotion = savedPromotion(saved);
  return twitchPromotion ? { twitchPromotion } : {};
}

export function operatorTwitchPromotion(saved: SavedTwitch | null | undefined) {
  return { promotion: savedPromotion(saved), revision: saved?.revision ?? 0 };
}

export function nativeTwitchOpen(state: TournamentState) {
  return Boolean(
    state.baseline && (state.lifecycle === 'locked' || state.lifecycle === 'unlocked'),
  );
}

export const TwitchPromotionInput = z.object({
  planId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  promotion: z
    .object({
      channel: z
        .string()
        .max(200)
        .transform(twitchChannel)
        .pipe(z.string().min(1, 'Enter a Twitch channel name or link.')),
      expiresAt: z.iso.datetime({ precision: 3 }),
    })
    .nullable(),
});

const maxDuration = 8 * 60 * 60_000;

function validateExpiry(expiry: Date | null) {
  if (!expiry) return;
  const now = Date.now();
  if (expiry.getTime() <= now || expiry.getTime() > now + maxDuration)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The Twitch announcement must expire within the next eight hours.',
    });
}

export async function setTwitchPromotion(
  ctx: TrpcContext & { user: NonNullable<TrpcContext['user']> },
  { planId, expectedRevision, promotion }: z.output<typeof TwitchPromotionInput>,
) {
  return ctx.db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(eventPlans)
      .where(eq(eventPlans.id, planId))
      .for('update');
    if (!plan || plan.deletedAt)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
    await requireOperator(tx, planId, ctx.user);
    const saved = await readTwitchPromotion(tx, planId);
    const revision = saved?.revision ?? 0;
    const desiredChannel = promotion?.channel ?? null;
    const desiredExpiry = promotion ? new Date(promotion.expiresAt) : null;
    const matches =
      (saved?.channel ?? null) === desiredChannel &&
      (saved?.expiresAt?.getTime() ?? null) === (desiredExpiry?.getTime() ?? null);
    const replay = revision === expectedRevision + 1 && matches;
    if (!replay && revision !== expectedRevision)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The Twitch announcement changed. Refresh it before saving.',
      });
    if (replay) {
      validateExpiry(desiredExpiry);
      return operatorTwitchPromotion(saved);
    }

    const [handoff] = await tx
      .select({ planId: nativeLiveHandoffs.eventPlanId })
      .from(nativeLiveHandoffs)
      .where(eq(nativeLiveHandoffs.eventPlanId, planId));

    let open = plan.status === 'underway';
    let published = false;
    if (handoff) {
      if (!ctx.nativeRuntime)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The native live event is unavailable.',
        });
      // The journal read does not transfer ownership or lock the SQL plan.
      // Public reads still check the journal after reading this preference.
      const state = await ctx.nativeRuntime.state(planId);
      open = nativeTwitchOpen(state);
      published = state.settings.published;
    } else if (plan.bracketMode === 'native' && !plan.historicalAdoption) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Open the event workspace to start the native event first.',
      });
    } else if (open) {
      const [settings] = await tx
        .select({ published: eventOperationSettings.published })
        .from(eventOperationSettings)
        .where(eq(eventOperationSettings.eventPlanId, planId));
      published = settings?.published ?? false;
    }

    if (!open || (promotion && !published))
      throw new TRPCError({
        code: 'CONFLICT',
        message: promotion
          ? 'Publish the open event before announcing a Twitch stream.'
          : 'This event is closed and read-only.',
      });

    validateExpiry(desiredExpiry);
    const next = { channel: desiredChannel, expiresAt: desiredExpiry, revision: revision + 1 };
    await tx
      .insert(eventTwitchPromotions)
      .values({ eventPlanId: planId, ...next })
      .onConflictDoUpdate({ target: eventTwitchPromotions.eventPlanId, set: next });
    return operatorTwitchPromotion(next);
  });
}
