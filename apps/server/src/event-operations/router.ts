import { guestRouter } from './guestRouter';
import { eventDeliveryRouter } from './deliveryRouter';
import { sourceRefreshRouter } from './sourceRefreshRouter';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventAnnouncements, eventMatchAudit, eventOperationSettings, eventOperators, eventPrizes, eventScoreReports, eventStations, eventPlanEntries, eventAttendanceAudit, user } from '@smashclub/db';
import { adminProcedure, authedProcedure, publicProcedure, router } from '../trpc/trpc';
import { lockEvent, prepare, reportScore, requireOperator, reviewReport, snapshot, updateMatch } from './service';
import { applyAttendance, previewAttendance, resetOperations } from './attendance';
const attendanceInput = z.object({ planId: z.string().uuid(), action: z.enum(['add', 'withdraw']), playerId: z.string().uuid(), division: z.enum(['upper', 'lower']).optional(), poolIndex: z.number().int().min(0).optional(), reason: z.string().trim().max(200).optional(), acknowledgeExternalChange: z.boolean().optional() });
const planInput = z.object({ planId: z.string().uuid() });
export const eventOpsRouter = router({
    guests: guestRouter,
    delivery: eventDeliveryRouter,
    sources: sourceRefreshRouter,
    previewAttendance: authedProcedure.input(attendanceInput).query(async ({ ctx, input }) => { await requireOperator(ctx.db, input.planId, ctx.user); return previewAttendance(ctx.db, input); }),
    applyAttendance: authedProcedure.input(attendanceInput.extend({ revisionToken: z.string().min(1) })).mutation(({ ctx, input }) => applyAttendance(ctx.db, ctx.user, input)),
    resetOperations: authedProcedure.input(planInput).mutation(({ ctx, input }) => resetOperations(ctx.db, ctx.user, input.planId)),
    myReports: authedProcedure.input(planInput).query(({ ctx, input }) => ctx.db.select().from(eventScoreReports).where(and(eq(eventScoreReports.eventPlanId, input.planId), eq(eventScoreReports.userId, ctx.user.id))).orderBy(desc(eventScoreReports.createdAt))),
    snapshot: publicProcedure.input(planInput).query(({ ctx, input }) => snapshot(ctx.db, input.planId)),
    overview: authedProcedure.input(planInput).query(async ({ ctx, input }) => {
        await requireOperator(ctx.db, input.planId, ctx.user);
        return { ...await snapshot(ctx.db, input.planId, true), reports: (await ctx.db.select().from(eventScoreReports).where(eq(eventScoreReports.eventPlanId, input.planId)).orderBy(desc(eventScoreReports.createdAt))).map(report => ({ ...report, reporterLabel: report.guestSessionId ? 'Guest' : 'Player' })), audit: await ctx.db.select().from(eventMatchAudit).where(eq(eventMatchAudit.eventPlanId, input.planId)).orderBy(desc(eventMatchAudit.createdAt)).limit(100), tos: await ctx.db.select({ id: eventOperators.id, userId: eventOperators.userId, eventPlanId: eventOperators.eventPlanId, name: user.name, email: user.email }).from(eventOperators).innerJoin(user, eq(eventOperators.userId, user.id)).where(eq(eventOperators.eventPlanId, input.planId)), attendanceAudit: await ctx.db.select().from(eventAttendanceAudit).where(eq(eventAttendanceAudit.eventPlanId, input.planId)).orderBy(desc(eventAttendanceAudit.createdAt)).limit(100) };
    }),
    prepare: authedProcedure.input(planInput).mutation(async ({ ctx, input }) => { await requireOperator(ctx.db, input.planId, ctx.user); return prepare(ctx.db, input.planId); }),
    reportScore: authedProcedure.input(z.object({ matchId: z.string().uuid(), expectedRevision: z.number().int().min(0), requestId: z.string().min(1).max(100), score1: z.number().int().min(0).max(99), score2: z.number().int().min(0).max(99), outcome: z.enum(['played', 'bye', 'forfeit']), winnerId: z.string().uuid().optional() })).mutation(({ ctx, input }) => reportScore(ctx.db, ctx.user, input)),
    reviewReport: authedProcedure.input(z.object({ reportId: z.string().uuid(), approve: z.boolean() })).mutation(({ ctx, input }) => reviewReport(ctx.db, ctx.user, input.reportId, input.approve)),
    updateMatch: authedProcedure.input(z.object({ matchId: z.string().uuid(), expectedRevision: z.number().int().min(0), status: z.enum(['ready', 'playing', 'blocked']), stationId: z.string().uuid().nullable().optional(), blockedReason: z.string().max(200).nullable().optional() })).mutation(({ ctx, input }) => updateMatch(ctx.db, ctx.user, input)),
    settings: adminProcedure.input(planInput.extend({ published: z.boolean(), playerReports: z.boolean() })).mutation(({ ctx, input }) => ctx.db.transaction(async (tx) => { await lockEvent(tx, input.planId); return tx.insert(eventOperationSettings).values({ eventPlanId: input.planId, published: input.published, playerReports: input.playerReports }).onConflictDoUpdate({ target: eventOperationSettings.eventPlanId, set: { published: input.published, playerReports: input.playerReports } }).returning(); })),
    assignTo: adminProcedure.input(planInput.extend({ userId: z.string().min(1).optional(), email: z.email().optional(), remove: z.boolean().optional() }).refine(v => !!v.userId !== !!v.email, { message: 'Provide an account ID or email.' })).mutation(({ ctx, input }) => ctx.db.transaction(async (tx) => {
        await lockEvent(tx, input.planId);
        const [account] = await tx.select().from(user).where(input.userId ? eq(user.id, input.userId) : sql `lower(${user.email}) = ${input.email!.toLowerCase()}`);
        if (!account)
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'This person must sign in to Nemesis first. No account matches that email or ID.' });
        if (input.remove)
            return tx.delete(eventOperators).where(and(eq(eventOperators.eventPlanId, input.planId), eq(eventOperators.userId, account.id))).returning();
        return tx.insert(eventOperators).values({ eventPlanId: input.planId, userId: account.id }).onConflictDoNothing().returning();
    })),
    saveStation: authedProcedure.input(planInput.extend({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(60) })).mutation(async ({ ctx, input }) => { await requireOperator(ctx.db, input.planId, ctx.user); return ctx.db.transaction(async (tx) => { await lockEvent(tx, input.planId); return input.id ? tx.update(eventStations).set({ name: input.name }).where(and(eq(eventStations.id, input.id), eq(eventStations.eventPlanId, input.planId))).returning() : tx.insert(eventStations).values({ eventPlanId: input.planId, name: input.name }).returning(); }); }),
    announce: authedProcedure.input(planInput.extend({ message: z.string().trim().min(1).max(500) })).mutation(async ({ ctx, input }) => { await requireOperator(ctx.db, input.planId, ctx.user); return ctx.db.transaction(async (tx) => { await lockEvent(tx, input.planId); return tx.insert(eventAnnouncements).values({ eventPlanId: input.planId, message: input.message }).returning(); }); }),
    savePrize: authedProcedure.input(planInput.extend({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional(), playerId: z.string().uuid().nullable().optional() })).mutation(async ({ ctx, input }) => {
        await requireOperator(ctx.db, input.planId, ctx.user);
        return ctx.db.transaction(async (tx) => {
            await lockEvent(tx, input.planId);
            if (input.playerId && !(await tx.select().from(eventPlanEntries).where(and(eq(eventPlanEntries.eventPlanId, input.planId), eq(eventPlanEntries.playerId, input.playerId))))[0])
                throw new TRPCError({ code: 'BAD_REQUEST', message: 'Prize recipient must be an event entrant.' });
            const values = { title: input.title, description: input.description ?? null, playerId: input.playerId ?? null };
            return input.id ? tx.update(eventPrizes).set(values).where(and(eq(eventPrizes.id, input.id), eq(eventPrizes.eventPlanId, input.planId))).returning() : tx.insert(eventPrizes).values({ ...values, eventPlanId: input.planId }).returning();
        });
    }),
});
