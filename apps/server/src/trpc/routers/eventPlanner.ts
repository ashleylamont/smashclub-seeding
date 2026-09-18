import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { EventPlanValidationError } from '../../event-planner/divisions';
import { buildExports } from '../../event-planner/exports';
import {
  EventPlanStateError,
  addPlanRows,
  attachBracket,
  closePlan,
  createPlan,
  deletePlan,
  detachBracket,
  freezeRoster,
  generatePools,
  getPlan,
  listPlans,
  previewRoster,
  removeEntry,
  reorderDivision,
  savePoolPlacements,
  unfreezeRoster,
  updateEntry,
  updatePlanDetails,
} from '../../event-planner/plans';
import { ROSTER_MAX_BYTES } from '../../event-planner/roster';
import { adminProcedure, router } from '../trpc';

/**
 * The event planner's API.
 *
 * Every mutation re-checks the plan's state server-side. A wizard is exactly
 * the shape of UI where a second tab, a back button or a stale page produces a
 * call the buttons on screen say is impossible, and "the button was disabled"
 * is not a guarantee about anything.
 */

const divisionSchema = z.enum(['upper', 'lower']);
const stageSchema = z.enum(['main', 'consolation']);
const preferenceSchema = z.enum(['auto', 'upper', 'lower']);

/** Translate the planner's own errors into the tRPC codes a client can act on. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EventPlanValidationError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
    }
    if (error instanceof EventPlanStateError) {
      throw new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
    }
    throw error;
  }
}

export const eventPlannerRouter = router({
  plans: adminProcedure.query(({ ctx }) => listPlans(ctx.db)),

  /**
   * Parse and resolve a pasted list. A mutation rather than a query only
   * because the roster is a whole document and tRPC puts query input in the
   * URL; it writes nothing — no players, no aliases, no review items.
   */
  previewRoster: adminProcedure
    .input(z.object({ text: z.string().max(ROSTER_MAX_BYTES) }))
    .mutation(({ ctx, input }) => previewRoster(ctx.db, input.text)),

  createPlan: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        eventDate: z.iso.datetime(),
        slugPrefix: z.string().trim().max(60).nullable().default(null),
        upperTargetSize: z.number().int().positive().nullable().default(null),
        rows: z
          .array(
            z.object({
              lineNumber: z.number().int().nonnegative(),
              rawInput: z.string().max(500),
              cleanedName: z.string().max(200),
              companyId: z.uuid().nullable(),
              playerId: z.uuid().nullable(),
              resolutionMethod: z.enum(['alias', 'decision', 'structured', 'manual', 'new', 'unresolved']),
              divisionPreference: preferenceSchema.default('auto'),
            }),
          )
          .max(500)
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const planId = await guard(() =>
        createPlan(
          ctx.db,
          { ...input, eventDate: new Date(input.eventDate) },
          ctx.user.id,
        ),
      );
      return { planId };
    }),

  plan: adminProcedure.input(z.object({ planId: z.uuid() })).query(({ ctx, input }) => getPlan(ctx.db, input.planId)),

  updatePlan: adminProcedure
    .input(
      z.object({
        planId: z.uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        eventDate: z.iso.datetime().optional(),
        slugPrefix: z.string().trim().max(60).nullable().optional(),
        upperTargetSize: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { planId, eventDate, ...rest } = input;
      await guard(() =>
        updatePlanDetails(ctx.db, planId, {
          ...rest,
          ...(eventDate !== undefined ? { eventDate: new Date(eventDate) } : {}),
        }),
      );
      return { ok: true };
    }),

  addRows: adminProcedure
    .input(z.object({ planId: z.uuid(), text: z.string().max(ROSTER_MAX_BYTES) }))
    .mutation(async ({ ctx, input }) => {
      const added = await guard(() => addPlanRows(ctx.db, input.planId, input.text));
      return { added };
    }),

  updateEntry: adminProcedure
    .input(
      z.object({
        planId: z.uuid(),
        entryId: z.uuid(),
        playerId: z.uuid().nullable().optional(),
        divisionPreference: preferenceSchema.optional(),
        /** `new` records that the player was minted for this row. */
        resolutionMethod: z.enum(['manual', 'new']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { planId, entryId, ...patch } = input;
      await guard(() => updateEntry(ctx.db, planId, entryId, patch));
      return { ok: true };
    }),

  removeEntry: adminProcedure
    .input(z.object({ planId: z.uuid(), entryId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await guard(() => removeEntry(ctx.db, input.planId, input.entryId));
      return { ok: true };
    }),

  freezeRoster: adminProcedure.input(z.object({ planId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await guard(() => freezeRoster(ctx.db, input.planId));
    return { ok: true };
  }),

  unfreezeRoster: adminProcedure.input(z.object({ planId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await guard(() => unfreezeRoster(ctx.db, input.planId));
    return { ok: true };
  }),

  reorderDivision: adminProcedure
    .input(
      z.object({
        planId: z.uuid(),
        division: divisionSchema,
        orderedEntryIds: z.array(z.uuid()).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await guard(() => reorderDivision(ctx.db, input.planId, input.division, input.orderedEntryIds));
      return { ok: true };
    }),

  generatePools: adminProcedure.input(z.object({ planId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await guard(() => generatePools(ctx.db, input.planId));
    return { ok: true };
  }),

  savePoolPlacements: adminProcedure
    .input(
      z.object({
        planId: z.uuid(),
        division: divisionSchema,
        pools: z
          .array(
            z.object({
              poolIndex: z.number().int().nonnegative(),
              playerIdsInOrder: z.array(z.uuid()).min(2).max(16),
              expectedPlacementRevision:z.string().optional(),
              expectedMatchRevisions:z.array(z.object({id:z.uuid(),revision:z.number().int().nonnegative()})).optional(),
            }),
          )
          .max(64),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await guard(() => savePoolPlacements(ctx.db, input.planId, input.division, input.pools));
      return { ok: true };
    }),

  attachBracket: adminProcedure
    .input(
      z.object({
        planId: z.uuid(),
        division: divisionSchema,
        stage: stageSchema,
        challongeSlug: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(() => attachBracket(ctx.db, input.planId, input.division, input.stage, input.challongeSlug)),
    ),

  detachBracket: adminProcedure
    .input(z.object({ planId: z.uuid(), division: divisionSchema, stage: stageSchema }))
    .mutation(async ({ ctx, input }) => {
      await guard(() => detachBracket(ctx.db, input.planId, input.division, input.stage));
      return { ok: true };
    }),

  /**
   * The manual handoff payload. Available at every stage, including after a
   * bracket has been created remotely — a bracket that has to be rebuilt at the
   * venue is precisely when this must not have disappeared.
   */
  exports: adminProcedure.input(z.object({ planId: z.uuid() })).query(async ({ ctx, input }) => {
    const view = await getPlan(ctx.db, input.planId);
    if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'That event plan no longer exists.' });
    return buildExports(view);
  }),

  /** Mark the night finished, or call it off. Both are one-way. */
  closePlan: adminProcedure
    .input(z.object({ planId: z.uuid(), status: z.enum(['complete', 'cancelled']) }))
    .mutation(async ({ ctx, input }) => {
      await guard(() => closePlan(ctx.db, input.planId, input.status));
      return { ok: true };
    }),

  deletePlan: adminProcedure.input(z.object({ planId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await guard(() => deletePlan(ctx.db, input.planId));
    return { ok: true };
  }),
});
