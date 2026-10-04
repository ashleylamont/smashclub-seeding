import { nativeEvent, nativeEntity, reportViews } from '../tournament/api';
import { nativeOverview, nativePublicEvents, nativeRoster } from '../tournament/queries';
import { publicEventNights } from './publicEvents';
import { nativeLiveRouter } from '../tournament/router';
import { startPoolMatch } from './selfService';
import { nativeBracketRouter } from './nativeRouter';
import { guestRouter } from './guestRouter';
import { eventDeliveryRouter } from './deliveryRouter';
import { sourceRefreshRouter } from './sourceRefreshRouter';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  eventMatchAudit,
  eventOperationSettings,
  eventOperators,
  eventPrizes,
  eventScoreReports,
  eventPlanEntries,
  eventPlans,
  eventAttendanceAudit,
  user,
} from '@smashclub/db';
import { adminProcedure, authedProcedure, publicProcedure, router } from '../trpc/trpc';
import {
  lockEvent,
  prepare,
  reportScore,
  requireOperator,
  reviewReport,
  snapshot,
  updateMatch,
} from './service';
import { configurePools, configurePool, publishAnnouncement, updateLiveScore } from './controls';
import {
  applyAttendance,
  previewAttendance,
  resetOperations,
  softLockPools,
  unlockPools,
} from './attendance';
import { deleteStation, saveStation } from './stations';
import { attendeeRoster, updateAttendee } from './attendeeRoster';
const attendanceInput = z.object({
  planId: z.string().uuid(),
  action: z.enum(['add', 'withdraw', 'no_show', 'redistribute']),
  playerId: z.string().uuid(),
  division: z.enum(['upper', 'lower']).optional(),
  poolIndex: z.number().int().min(0).optional(),
  reason: z.string().trim().max(200).optional(),
  acknowledgeExternalChange: z.boolean().optional(),
  approveRedistribution: z.boolean().optional(),
});
const planInput = z.object({
  planId: z.string().uuid(),
  requestId: z.string().min(1).max(128).optional(),
  expectedResourceRevision: z.number().int().nonnegative().optional(),
});
export const eventOpsRouter = router({
  live: nativeLiveRouter,
  publicEvents: publicProcedure.query(({ ctx }) =>
    nativePublicEvents(ctx, () => publicEventNights(ctx.db)),
  ),
  attendeeRoster: authedProcedure.input(planInput).query(async ({ ctx, input }) => {
    const api = await nativeEvent(ctx, input.planId, false, input);
    return api ? nativeRoster(api) : attendeeRoster(ctx.db, input.planId, ctx.user);
  }),
  updateAttendee: authedProcedure
    .input(
      planInput.extend({
        playerId: z.uuid(),
        canonicalName: z.string().trim().min(1).max(120),
        displayName: z.string().trim().min(1).max(80).nullable(),
        companyCode: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      return updateAttendee(
        ctx.db,
        ctx.user,
        input,
        api
          ? (await api.state()).entrants
              .filter((e) => e.availability !== 'withdrawn')
              .map((e) => e.playerId)
          : undefined,
      );
    }),
  startPoolMatch: authedProcedure
    .input(
      z.object({
        planId: z.string().uuid(),
        matchId: z.string().uuid(),
        stationId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, true, input);
      return api
        ? api.updateMatch({ ...input, status: 'playing' })
        : startPoolMatch(ctx.db, ctx.user, input);
    }),
  updateLiveScore: authedProcedure
    .input(
      z.object({
        matchId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
        score1: z.number().int().min(0).max(5),
        score2: z.number().int().min(0).max(5),
        expectedProgressRevision: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEntity(ctx, input.matchId, 'match', input);
      if (!api) return updateLiveScore(ctx.db, ctx.user, input);
      const state = await api.state();
      await api.execute({
        ...input,
        kind: 'progress',
        expectedProgressRevision:
          input.expectedProgressRevision ??
          state.matches.find((m) => m.id === input.matchId)!.progressRevision,
      });
      return (await api.snapshot(true)).matches.find((m) => m.id === input.matchId)!;
    }),
  configurePools: authedProcedure
    .input(
      planInput.extend({
        pools: z
          .array(
            z.object({
              division: z.enum(['upper', 'lower']),
              poolIndex: z.number().int().min(0),
              active: z.boolean(),
              stationIds: z.array(z.string().uuid()).max(64),
              selfRun: z.boolean().optional(),
              autoAcceptScores: z.boolean().optional(),
              expectedRevision: z.number().int().min(0),
            }),
          )
          .min(1)
          .max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (!api) return configurePools(ctx.db, ctx.user, input);
      const state = await api.state();
      await api.execute({
        kind: 'configurePools',
        pools: input.pools.map((p) => {
          const pool = state.pools.find(
            (row) => row.division === p.division && row.index === p.poolIndex,
          );
          if (!pool) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pool not found.' });
          return {
            ...p,
            poolId: pool.id,
            selfRun: p.selfRun ?? pool.selfRun,
            autoAcceptScores: p.autoAcceptScores ?? pool.autoAcceptScores,
          };
        }),
      });
      return input.pools;
    }),
  configurePool: authedProcedure
    .input(
      planInput.extend({
        division: z.enum(['upper', 'lower']),
        poolIndex: z.number().int().min(0),
        active: z.boolean(),
        stationIds: z.array(z.string().uuid()).max(64),
        expectedRevision: z.number().int().min(0).optional(),
        selfRun: z.boolean().optional(),
        autoAcceptScores: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (!api) return configurePool(ctx.db, ctx.user, input);
      const state = await api.state();
      const pool = state.pools.find(
        (p) => p.division === input.division && p.index === input.poolIndex,
      );
      if (!pool) throw new TRPCError({ code: 'NOT_FOUND' });
      await api.execute({
        kind: 'configurePools',
        pools: [
          {
            ...input,
            poolId: pool.id,
            expectedRevision: input.expectedRevision ?? pool.scheduleRevision,
            selfRun: input.selfRun ?? pool.selfRun,
            autoAcceptScores: input.autoAcceptScores ?? pool.autoAcceptScores,
          },
        ],
      });
      return input;
    }),
  native: nativeBracketRouter,
  guests: guestRouter,
  delivery: eventDeliveryRouter,
  sources: sourceRefreshRouter,
  previewAttendance: authedProcedure.input(attendanceInput).query(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    const api = await nativeEvent(ctx, input.planId, false, input);
    return api ? api.previewAttendance(input) : previewAttendance(ctx.db, input);
  }),
  softLockPools: authedProcedure
    .input(planInput.extend({ confirm: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await requireOperator(ctx.db, input.planId, ctx.user);
      const api = await nativeEvent(ctx, input.planId, true, input);
      if (!api) return softLockPools(ctx.db, ctx.user, input.planId);
      const state = await api.state();
      if (state.lifecycle === 'unlocked') await api.execute({ kind: 'relock' });
      return { softLockedAt: new Date(state.baseline!.capturedAt).toISOString() };
    }),
  unlockPools: authedProcedure
    .input(planInput.extend({ confirm: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (!api) return unlockPools(ctx.db, ctx.user, input.planId);
      await api.execute({ kind: 'unlock' });
      return { unlocked: true };
    }),
  applyAttendance: authedProcedure
    .input(attendanceInput.extend({ revisionToken: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      return api ? api.attendance(input) : applyAttendance(ctx.db, ctx.user, input);
    }),
  resetOperations: authedProcedure.input(planInput).mutation(async ({ ctx, input }) => {
    const api = await nativeEvent(ctx, input.planId, false, input);
    if (!api) return resetOperations(ctx.db, ctx.user, input.planId);
    const removedMatches = (await api.state()).matches.length;
    await api.execute({ kind: 'resetQueue' });
    return { removedMatches };
  }),
  myReports: authedProcedure.input(planInput).query(async ({ ctx, input }) => {
    const api = await nativeEvent(ctx, input.planId, false, input);
    if (api) return reportViews(await api.state()).filter((r) => r.userId === ctx.user.id);
    return ctx.db
      .select()
      .from(eventScoreReports)
      .where(
        and(
          eq(eventScoreReports.eventPlanId, input.planId),
          eq(eventScoreReports.userId, ctx.user.id),
        ),
      )
      .orderBy(desc(eventScoreReports.createdAt));
  }),
  snapshot: publicProcedure.input(planInput).query(async ({ ctx, input }) => {
    const api = await nativeEvent(ctx, input.planId, false, input);
    return api ? api.snapshot() : snapshot(ctx.db, input.planId);
  }),
  overview: authedProcedure.input(planInput).query(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    const api = await nativeEvent(ctx, input.planId, false, input);
    if (api) return nativeOverview(api);
    return {
      ...(await snapshot(ctx.db, input.planId, true)),
      reports: (
        await ctx.db
          .select()
          .from(eventScoreReports)
          .where(eq(eventScoreReports.eventPlanId, input.planId))
          .orderBy(desc(eventScoreReports.createdAt))
      ).map((report) => ({ ...report, reporterLabel: report.guestSessionId ? 'Guest' : 'Player' })),
      audit: await ctx.db
        .select()
        .from(eventMatchAudit)
        .where(eq(eventMatchAudit.eventPlanId, input.planId))
        .orderBy(desc(eventMatchAudit.createdAt))
        .limit(100),
      tos: await ctx.db
        .select({
          id: eventOperators.id,
          userId: eventOperators.userId,
          eventPlanId: eventOperators.eventPlanId,
          name: user.name,
          email: user.email,
        })
        .from(eventOperators)
        .innerJoin(user, eq(eventOperators.userId, user.id))
        .where(eq(eventOperators.eventPlanId, input.planId)),
      attendanceAudit: await ctx.db
        .select()
        .from(eventAttendanceAudit)
        .where(eq(eventAttendanceAudit.eventPlanId, input.planId))
        .orderBy(desc(eventAttendanceAudit.createdAt))
        .limit(100),
    };
  }),
  prepare: authedProcedure.input(planInput).mutation(async ({ ctx, input }) => {
    await requireOperator(ctx.db, input.planId, ctx.user);
    const api = await nativeEvent(ctx, input.planId, false, input);
    return api ? { created: 0 } : prepare(ctx.db, input.planId);
  }),
  reportScore: authedProcedure
    .input(
      z.object({
        matchId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
        requestId: z.string().min(1).max(100),
        score1: z.number().int().min(0).max(99),
        score2: z.number().int().min(0).max(99),
        outcome: z.enum(['played', 'bye', 'forfeit']),
        winnerId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEntity(ctx, input.matchId, 'match', input);
      return api ? api.report(input) : reportScore(ctx.db, ctx.user, input);
    }),
  reviewReport: authedProcedure
    .input(z.object({ reportId: z.string().uuid(), approve: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEntity(ctx, input.reportId, 'report', input);
      return api
        ? api.review(input.reportId, input.approve)
        : reviewReport(ctx.db, ctx.user, input.reportId, input.approve);
    }),
  updateMatch: authedProcedure
    .input(
      z.object({
        matchId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
        status: z.enum(['ready', 'playing', 'blocked']),
        expectedResourceRevision: z.number().int().nonnegative().optional(),
        stationId: z.string().uuid().nullable().optional(),
        blockedReason: z.string().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEntity(ctx, input.matchId, 'match', input);
      return api ? api.updateMatch(input) : updateMatch(ctx.db, ctx.user, input);
    }),
  settings: adminProcedure
    .input(
      planInput.extend({
        published: z.boolean(),
        playerReports: z.boolean(),
        scoreReportingMode: z.enum(['to_review', 'approve_unless_disputed']).optional(),
        expectedReportingRevision: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (api) {
        const state = await api.state();
        await api.execute({
          kind: 'reporting',
          published: input.published,
          playerReports: input.playerReports,
          mode: input.scoreReportingMode ?? state.settings.scoreReportingMode,
          expectedRevision: input.expectedReportingRevision ?? state.settings.reportingRevision,
        });
        return [input];
      }
      return ctx.db.transaction(async (tx) => {
        const plan = await lockEvent(tx, input.planId);
        if (input.scoreReportingMode === 'approve_unless_disputed' && plan.bracketMode !== 'native')
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Automatic approval is available for native Nemesis events only.',
          });
        const settings = {
          published: input.published,
          playerReports: input.playerReports,
          ...(input.scoreReportingMode ? { scoreReportingMode: input.scoreReportingMode } : {}),
        };
        return tx
          .insert(eventOperationSettings)
          .values({ eventPlanId: input.planId, ...settings })
          .onConflictDoUpdate({ target: eventOperationSettings.eventPlanId, set: settings })
          .returning();
      });
    }),
  assignTo: adminProcedure
    .input(
      planInput
        .extend({
          userId: z.string().min(1).optional(),
          email: z.email().optional(),
          remove: z.boolean().optional(),
        })
        .refine((v) => Boolean(v.userId) !== Boolean(v.email), {
          message: 'Provide an account ID or email.',
        }),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        await tx.select().from(eventPlans).where(eq(eventPlans.id, input.planId)).for('update');
        const [account] = await tx
          .select()
          .from(user)
          .where(
            input.userId
              ? eq(user.id, input.userId)
              : sql`lower(${user.email}) = ${input.email!.toLowerCase()}`,
          );
        if (!account)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'This person must sign in to Nemesis first. No account matches that email or ID.',
          });
        if (input.remove)
          return tx
            .delete(eventOperators)
            .where(
              and(
                eq(eventOperators.eventPlanId, input.planId),
                eq(eventOperators.userId, account.id),
              ),
            )
            .returning();
        return tx
          .insert(eventOperators)
          .values({ eventPlanId: input.planId, userId: account.id })
          .onConflictDoNothing()
          .returning();
      }),
    ),
  saveStation: authedProcedure
    .input(
      planInput.extend({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(60),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (!api) return saveStation(ctx.db, ctx.user, input);
      const state = await api.state();
      const id = input.id ?? api.newId('entity');
      await api.execute({
        kind: 'station',
        id,
        name: input.name,
        expectedResourceRevision: input.expectedResourceRevision ?? state.settings.resourceRevision,
      });
      return [{ id, eventPlanId: input.planId, name: input.name }];
    }),
  deleteStation: authedProcedure
    .input(planInput.extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (!api) return deleteStation(ctx.db, ctx.user, input);
      await api.execute({
        kind: 'station',
        id: input.id,
        name: null,
        expectedResourceRevision:
          input.expectedResourceRevision ?? (await api.state()).settings.resourceRevision,
      });
      return { deleted: true };
    }),
  announce: authedProcedure
    .input(
      planInput.extend({
        message: z.string().trim().min(1).max(500),
        durationSeconds: z.number().int().min(1).max(86400).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (!api) return publishAnnouncement(ctx.db, ctx.user, input);
      await api.execute({
        kind: 'announce',
        message: input.message,
        durationSeconds: input.durationSeconds ?? null,
      });
      return (await api.snapshot(true)).announcements.at(-1);
    }),
  savePrize: authedProcedure
    .input(
      planInput.extend({
        id: z.string().uuid().optional(),
        title: z.string().trim().min(1).max(100),
        description: z.string().max(500).nullable().optional(),
        playerId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOperator(ctx.db, input.planId, ctx.user);
      const api = await nativeEvent(ctx, input.planId, false, input);
      if (api) {
        const id = input.id ?? api.newId('entity');
        await api.execute({
          kind: 'prize',
          id,
          title: input.title,
          description: input.description ?? null,
          playerId: input.playerId ?? null,
        });
        return (await api.snapshot(true)).prizes.filter((p) => p.id === id);
      }
      return ctx.db.transaction(async (tx) => {
        await lockEvent(tx, input.planId);
        if (
          input.playerId &&
          !(
            await tx
              .select()
              .from(eventPlanEntries)
              .where(
                and(
                  eq(eventPlanEntries.eventPlanId, input.planId),
                  eq(eventPlanEntries.playerId, input.playerId),
                ),
              )
          )[0]
        )
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Prize recipient must be an event entrant.',
          });
        const values = {
          title: input.title,
          description: input.description ?? null,
          playerId: input.playerId ?? null,
        };
        return input.id
          ? tx
              .update(eventPrizes)
              .set(values)
              .where(and(eq(eventPrizes.id, input.id), eq(eventPrizes.eventPlanId, input.planId)))
              .returning()
          : tx
              .insert(eventPrizes)
              .values({ ...values, eventPlanId: input.planId })
              .returning();
      });
    }),
});
