import { z } from 'zod';
import { authedProcedure, publicProcedure, router } from '../trpc/trpc';
import { configureGuests, guestInvitation, guestMatches, guestSettings, redeemGuest, rotateGuests, submitGuest } from './guests';
const plan = z.object({ planId: z.string().uuid() });
const session = plan.extend({ sessionToken: z.string().min(32).max(100) });
export const guestRouter = router({
    settings: authedProcedure.input(plan).query(({ ctx, input }) => guestSettings(ctx.db, ctx.user, input.planId)),
    configure: authedProcedure.input(plan.extend({ enabled: z.boolean(), showOnOverlay: z.boolean() })).mutation(({ ctx, input }) => configureGuests(ctx.db, ctx.user, input)),
    rotate: authedProcedure.input(plan).mutation(({ ctx, input }) => rotateGuests(ctx.db, ctx.user, input.planId)),
    invitation: authedProcedure.input(plan).mutation(({ ctx, input }) => guestInvitation(ctx.db, input.planId, ctx.user)),
    overlayInvitation: publicProcedure.input(plan).query(({ ctx, input }) => guestInvitation(ctx.db, input.planId)),
    redeem: publicProcedure.input(plan.extend({ token: z.string().min(1).max(150) })).mutation(({ ctx, input }) => redeemGuest(ctx.db, input, ctx.clientIp)),
    // POST intentionally keeps the bearer credential out of URLs and request logs.
    matches: publicProcedure.input(session).mutation(({ ctx, input }) => guestMatches(ctx.db, input)),
    submit: publicProcedure.input(session.extend({ matchId: z.string().uuid(), expectedRevision: z.number().int().min(0), requestId: z.string().min(1).max(100), score1: z.number().int().min(0).max(5), score2: z.number().int().min(0).max(5) })).mutation(({ ctx, input }) => submitGuest(ctx.db, input)),
});
