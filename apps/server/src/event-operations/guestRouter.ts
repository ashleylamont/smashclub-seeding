import { nativeEvent, nativeTransport, reportViews } from '../tournament/api';
import { hash } from '../tournament/facts';
import { startPoolMatch } from './selfService';
import { z } from 'zod';
import { authedProcedure, publicProcedure, router } from '../trpc/trpc';
import {
  validateGuestSession,
  configureGuests,
  guestInvitation,
  guestMatches,
  guestSettings,
  redeemGuest,
  rotateGuests,
  submitGuest,
} from './guests';
const plan = z.object({ planId: z.string().uuid() });
const session = plan.extend({ sessionToken: z.string().min(32).max(100) });
export const guestRouter = router({
  startPoolMatch: publicProcedure
    .input(
      session.extend({
        matchId: z.string().uuid(),
        stationId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
        requestId: z.string().min(1).max(128).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, true);
      if (!api) return startPoolMatch(ctx.db, null, input);
      const guest = await validateGuestSession(ctx.db, input, Date.now(), ctx.nativeRuntime);
      const actor = {
        id: `guest:${guest.id}`,
        guest: true,
        name: 'Guest',
        email: 'guest@internal',
        role: 'user' as const,
      };
      const state = await api.state();
      await nativeTransport(() =>
        api.runtime.command(
          actor,
          input.planId,
          input.requestId ??
            `start:${input.matchId}:${input.expectedRevision}:${state.settings.resourceRevision}`,
          {
            kind: 'dispatch',
            matchId: input.matchId,
            expectedRevision: input.expectedRevision,
            expectedResourceRevision: state.settings.resourceRevision,
            stationId: input.stationId,
          },
          hash({
            matchId: input.matchId,
            stationId: input.stationId,
            expectedRevision: input.expectedRevision,
          }),
        ),
      );
      return (await api.snapshot()).matches.find((m) => m.id === input.matchId)!;
    }),
  settings: authedProcedure
    .input(plan)
    .query(({ ctx, input }) => guestSettings(ctx.db, ctx.user, input.planId)),
  configure: authedProcedure
    .input(
      plan.extend({
        enabled: z.boolean(),
        showOnOverlay: z.boolean(),
        rotateInvitations: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      configureGuests(ctx.db, ctx.user, input, false, ctx.nativeRuntime),
    ),
  rotate: authedProcedure
    .input(plan)
    .mutation(({ ctx, input }) => rotateGuests(ctx.db, ctx.user, input.planId, ctx.nativeRuntime)),
  invitation: authedProcedure
    .input(plan)
    .mutation(({ ctx, input }) =>
      guestInvitation(ctx.db, input.planId, ctx.user, Date.now(), ctx.nativeRuntime),
    ),
  overlayInvitation: publicProcedure
    .input(plan)
    .query(({ ctx, input }) =>
      guestInvitation(ctx.db, input.planId, undefined, Date.now(), ctx.nativeRuntime),
    ),
  redeem: publicProcedure
    .input(plan.extend({ token: z.string().min(1).max(150) }))
    .mutation(({ ctx, input }) =>
      redeemGuest(ctx.db, input, ctx.clientIp, Date.now(), ctx.nativeRuntime),
    ),
  // POST intentionally keeps the bearer credential out of URLs and request logs.
  matches: publicProcedure.input(session).mutation(async ({ ctx, input }) => {
    const api = await nativeEvent(ctx, input.planId);
    if (!api) return guestMatches(ctx.db, input);
    const guest = await validateGuestSession(ctx.db, input, Date.now(), ctx.nativeRuntime);
    const data = await api.snapshot();
    return {
      ...data,
      reports: reportViews(await api.state()).filter((r) => r.guestSessionId === guest.id),
      expiresAt: guest.expiresAt.toISOString(),
    };
  }),
  submit: publicProcedure
    .input(
      session.extend({
        matchId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
        requestId: z.string().min(1).max(100),
        score1: z.number().int().min(0).max(5),
        score2: z.number().int().min(0).max(5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, true);
      if (!api) return submitGuest(ctx.db, input);
      const guest = await validateGuestSession(ctx.db, input, Date.now(), ctx.nativeRuntime);
      const actor = {
        id: `guest:${guest.id}`,
        guest: true,
        name: 'Guest',
        email: 'guest@internal',
        role: 'user' as const,
      };
      const result = await nativeTransport(() =>
        api.runtime.command(actor, input.planId, input.requestId, {
          kind: 'score',
          matchId: input.matchId,
          expectedRevision: input.expectedRevision,
          score1: input.score1,
          score2: input.score2,
          outcome: 'played',
        }),
      );
      const report = (await api.state()).reports.find((r) => r.id === result.receipt.reportId)!;
      return { reportId: report.id, status: report.status, isDispute: report.isDispute };
    }),
});
