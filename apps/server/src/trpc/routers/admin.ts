import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { asc, desc, eq } from 'drizzle-orm';
import {
  companies,
  companyAliases,
  playerAliases,
  playerClaims,
  players,
  reviewItems,
  sets,
  syncJobs,
  tournamentParticipants,
  tournaments,
  user,
} from '@smashclub/db';
import { normalizeTournamentId } from '@smashclub/engine';
import { glickoSettingsSchema } from '@smashclub/shared';
import { ensureAlias } from '../../identity/matching';
import { mergePlayers } from '../../players/merge';
import { compareModels } from '../../recompute/compareModels';
import { resolveReviewItem } from '../../review/resolve';
import {
  createSeedingRun,
  latestSeedingRun,
  pushSeedingRun,
  reorderSeedingRun,
  setEntryLocked,
} from '../../seeding/seeding';
import { getGlickoSettings, updateGlickoSettings } from '../../settings';
import { syncTournament } from '../../sync/sync';
import { adminProcedure, router } from '../trpc';

export const adminRouter = router({
  // --- tournaments ---
  registerTournament: adminProcedure
    .input(z.object({ slugOrUrl: z.string().min(1), isRookie: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const slug = normalizeTournamentId(input.slugOrUrl);
      const [row] = await ctx.db
        .insert(tournaments)
        .values({
          challongeSlug: slug,
          name: slug,
          isRookie: input.isRookie ?? slug.toLowerCase().includes('rookie'),
        })
        .onConflictDoNothing()
        .returning({ id: tournaments.id });
      if (!row) throw new TRPCError({ code: 'CONFLICT', message: `Tournament ${slug} is already registered.` });
      return { tournamentId: row.id, slug };
    }),

  syncNow: adminProcedure.input(z.object({ tournamentId: z.uuid() })).mutation(async ({ ctx, input }) => {
    const result = await syncTournament(ctx.db, ctx.challonge, input.tournamentId);
    ctx.recomputeTrigger.request();
    return result;
  }),

  /**
   * Open a bounded live-monitoring window. Liveness is an explicit admin
   * decision that EXPIRES — it is never inferred from Challonge's `state`,
   * which is sticky enough that abandoned tournaments would be polled forever.
   *
   * While the window is open the tournament is polled roughly every 60s through
   * the unmetered public bracket, never the metered API. The window is capped
   * so a forgotten "go live" cannot run indefinitely; a completed bracket ends
   * it early (see sync.ts).
   */
  setTournamentLive: adminProcedure
    .input(
      z.object({
        tournamentId: z.uuid(),
        /** Window length. Capped at 12h — an event that runs longer can be re-armed. */
        hours: z.number().int().min(1).max(12).default(6),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const liveUntil = new Date(Date.now() + input.hours * 60 * 60 * 1000);
      await ctx.db
        .update(tournaments)
        .set({ liveUntil, updatedAt: new Date() })
        .where(eq(tournaments.id, input.tournamentId));
      return { liveUntil: liveUntil.toISOString() };
    }),

  /** Close the live window immediately. */
  endTournamentLive: adminProcedure
    .input(z.object({ tournamentId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(tournaments)
        .set({ liveUntil: null, updatedAt: new Date() })
        .where(eq(tournaments.id, input.tournamentId));
      return { ok: true };
    }),

  updateTournament: adminProcedure
    .input(
      z.object({
        tournamentId: z.uuid(),
        isRookie: z.boolean().optional(),
        eventDate: z.iso.datetime().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.isRookie !== undefined) patch.isRookie = input.isRookie;
      if (input.eventDate !== undefined) {
        patch.eventDate = input.eventDate ? new Date(input.eventDate) : null;
        patch.eventDateManual = input.eventDate !== null;
      }
      await ctx.db.update(tournaments).set(patch).where(eq(tournaments.id, input.tournamentId));
      ctx.recomputeTrigger.request();
      return { ok: true };
    }),

  setSetExclusion: adminProcedure
    .input(z.object({ setId: z.uuid(), excluded: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(sets)
        .set({ excludedFromRatings: input.excluded, exclusionManual: true, updatedAt: new Date() })
        .where(eq(sets.id, input.setId));
      ctx.recomputeTrigger.request();
      return { ok: true };
    }),

  jobs: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(syncJobs).orderBy(desc(syncJobs.startedAt)).limit(50);
    return rows.map((row) => ({
      ...row,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }),

  // --- review queue ---
  reviewQueue: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: reviewItems.id,
        rawName: reviewItems.rawName,
        cleanedName: reviewItems.cleanedName,
        candidates: reviewItems.candidates,
        createdAt: reviewItems.createdAt,
        companyCode: companies.code,
        tournamentName: tournaments.name,
        tournamentId: tournaments.id,
      })
      .from(reviewItems)
      .innerJoin(tournamentParticipants, eq(reviewItems.tournamentParticipantId, tournamentParticipants.id))
      .innerJoin(tournaments, eq(tournamentParticipants.tournamentId, tournaments.id))
      .leftJoin(companies, eq(reviewItems.companyId, companies.id))
      .where(eq(reviewItems.status, 'pending'))
      .orderBy(asc(reviewItems.createdAt));
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }),

  resolveReview: adminProcedure
    .input(
      z.object({
        reviewItemId: z.uuid(),
        resolution: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('linked_existing'), playerId: z.uuid() }),
          z.object({ kind: z.literal('created_new') }),
          z.object({ kind: z.literal('kept_separate') }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await resolveReviewItem(ctx.db, input.reviewItemId, input.resolution, ctx.user.id);
      ctx.recomputeTrigger.request();
      return result;
    }),

  // --- players / registry ---
  players: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: players.id,
        canonicalName: players.canonicalName,
        displayName: players.displayName,
        status: players.status,
        legacyId: players.legacyId,
        companyCode: companies.code,
      })
      .from(players)
      .leftJoin(companies, eq(players.companyId, companies.id))
      .orderBy(asc(players.canonicalName));
    const aliases = await ctx.db.select().from(playerAliases);
    const aliasesByPlayer = new Map<string, string[]>();
    for (const alias of aliases) {
      const list = aliasesByPlayer.get(alias.playerId) ?? [];
      list.push(alias.aliasNorm);
      aliasesByPlayer.set(alias.playerId, list);
    }
    return rows.map((row) => ({ ...row, aliases: [...new Set(aliasesByPlayer.get(row.id) ?? [])].sort() }));
  }),

  updatePlayer: adminProcedure
    .input(
      z.object({
        playerId: z.uuid(),
        canonicalName: z.string().trim().min(1).max(120).optional(),
        companyCode: z.string().nullable().optional(),
        displayName: z.string().trim().min(1).max(80).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.canonicalName !== undefined) patch.canonicalName = input.canonicalName;
      if (input.displayName !== undefined) patch.displayName = input.displayName;
      if (input.companyCode !== undefined) {
        if (input.companyCode === null) {
          patch.companyId = null;
        } else {
          const [company] = await ctx.db.select().from(companies).where(eq(companies.code, input.companyCode));
          if (!company) throw new TRPCError({ code: 'NOT_FOUND', message: `Unknown company ${input.companyCode}` });
          patch.companyId = company.id;
        }
      }
      await ctx.db.update(players).set(patch).where(eq(players.id, input.playerId));
      return { ok: true };
    }),

  addAlias: adminProcedure
    .input(z.object({ playerId: z.uuid(), alias: z.string().trim().min(1).max(120), companyCode: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      let companyId: string | null = null;
      if (input.companyCode) {
        const [company] = await ctx.db.select().from(companies).where(eq(companies.code, input.companyCode));
        if (!company) throw new TRPCError({ code: 'NOT_FOUND', message: `Unknown company ${input.companyCode}` });
        companyId = company.id;
      }
      await ensureAlias(ctx.db, input.playerId, input.alias.toLowerCase(), companyId, 'manual');
      return { ok: true };
    }),

  mergePlayers: adminProcedure
    .input(z.object({ fromPlayerId: z.uuid(), intoPlayerId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await mergePlayers(ctx.db, input.fromPlayerId, input.intoPlayerId);
      ctx.recomputeTrigger.request();
      return { ok: true };
    }),

  // --- companies ---
  companies: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(companies).orderBy(asc(companies.code));
    const aliases = await ctx.db.select().from(companyAliases);
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      aliases: aliases.filter((alias) => alias.companyId === row.id).map((alias) => alias.aliasNorm),
    }));
  }),

  upsertCompany: adminProcedure
    .input(z.object({ code: z.string().trim().min(1).max(10), name: z.string().trim().min(1).max(80), aliases: z.array(z.string()).default([]) }))
    .mutation(async ({ ctx, input }) => {
      const code = input.code.toUpperCase();
      const [company] = await ctx.db
        .insert(companies)
        .values({ code, name: input.name })
        .onConflictDoUpdate({ target: companies.code, set: { name: input.name, updatedAt: new Date() } })
        .returning({ id: companies.id });
      for (const alias of input.aliases) {
        await ctx.db
          .insert(companyAliases)
          .values({ companyId: company!.id, aliasNorm: alias })
          .onConflictDoNothing();
      }
      return { ok: true };
    }),

  // --- claims ---
  claims: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: playerClaims.id,
        status: playerClaims.status,
        note: playerClaims.note,
        createdAt: playerClaims.createdAt,
        userName: user.name,
        userEmail: user.email,
        canonicalName: players.canonicalName,
        displayName: players.displayName,
        playerId: players.id,
      })
      .from(playerClaims)
      .innerJoin(user, eq(playerClaims.userId, user.id))
      .innerJoin(players, eq(playerClaims.playerId, players.id))
      .orderBy(desc(playerClaims.createdAt))
      .limit(100);
    return rows.map((row) => ({
      ...row,
      playerName: row.displayName ?? row.canonicalName,
      createdAt: row.createdAt.toISOString(),
    }));
  }),

  resolveClaim: adminProcedure
    .input(z.object({ claimId: z.uuid(), action: z.enum(['approved', 'rejected', 'revoked']) }))
    .mutation(async ({ ctx, input }) => {
      const [claim] = await ctx.db.select().from(playerClaims).where(eq(playerClaims.id, input.claimId));
      if (!claim) throw new TRPCError({ code: 'NOT_FOUND' });
      await ctx.db
        .update(playerClaims)
        .set({ status: input.action, resolvedBy: ctx.user.id, resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(playerClaims.id, input.claimId));
      return { ok: true };
    }),

  // --- seeding ---
  createSeedingRun: adminProcedure
    .input(z.object({ tournamentId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const runId = await createSeedingRun(ctx.db, input.tournamentId, ctx.user.id);
      return { runId };
    }),

  seedingRun: adminProcedure.input(z.object({ tournamentId: z.uuid() })).query(async ({ ctx, input }) => {
    const result = await latestSeedingRun(ctx.db, input.tournamentId);
    if (!result) return null;
    return {
      run: {
        id: result.run.id,
        status: result.run.status,
        createdAt: result.run.createdAt.toISOString(),
        pushedAt: result.run.pushedAt?.toISOString() ?? null,
        pushLog: result.run.pushLog,
      },
      entries: result.entries.map((entry) => ({
        ...entry,
        name: entry.canonicalName ? (entry.displayName ?? entry.canonicalName) : entry.cleanedName,
      })),
    };
  }),

  reorderSeedingRun: adminProcedure
    .input(z.object({ runId: z.uuid(), participantIdsInOrder: z.array(z.uuid()) }))
    .mutation(async ({ ctx, input }) => {
      await reorderSeedingRun(ctx.db, input.runId, input.participantIdsInOrder);
      return { ok: true };
    }),

  setSeedingEntryLocked: adminProcedure
    .input(z.object({ entryId: z.uuid(), locked: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await setEntryLocked(ctx.db, input.entryId, input.locked);
      return { ok: true };
    }),

  pushSeedingRun: adminProcedure.input(z.object({ runId: z.uuid() })).mutation(async ({ ctx, input }) => {
    return pushSeedingRun(ctx.db, ctx.challonge, input.runId);
  }),

  // --- settings / recompute ---
  settings: adminProcedure.query(async ({ ctx }) => getGlickoSettings(ctx.db)),

  updateSettings: adminProcedure.input(glickoSettingsSchema).mutation(async ({ ctx, input }) => {
    const version = await updateGlickoSettings(ctx.db, input);
    ctx.recomputeTrigger.request();
    return { version };
  }),

  recomputeNow: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.recomputeTrigger.runNow();
    return { ok: true };
  }),

  /**
   * Side-by-side of what each rating model would publish. Read-only — switching
   * the active model moves every member's number, so it should never be a blind
   * setting change.
   */
  compareModels: adminProcedure.query(async ({ ctx }) => compareModels(ctx.db)),
});
