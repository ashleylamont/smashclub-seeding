import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';
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
import type { Db } from '@smashclub/db';
import { normalizeTournamentId } from '@smashclub/engine';
import { glickoSettingsSchema } from '@smashclub/shared';
import { ensureAlias } from '../../identity/matching';
import { charactersByPlayer, characterSlugsSchema, setPlayerCharacters } from '../../players/characters';
import { mergePlayers } from '../../players/merge';
import { compareModels } from '../../recompute/compareModels';
import { resolveReviewItem, type ReviewResolutionInput } from '../../review/resolve';
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

/**
 * Company code -> id, for the several mutations that take a human-facing code.
 * `null` passes straight through as "no company"; an unknown code is a client
 * error rather than a silent unset.
 */
async function resolveCompanyId(db: Db, code: string | null): Promise<string | null> {
  if (code === null || code === '') return null;
  const [company] = await db.select().from(companies).where(eq(companies.code, code));
  if (!company) throw new TRPCError({ code: 'NOT_FOUND', message: `Unknown company ${code}` });
  return company.id;
}

/**
 * Guard against two players publishing the same public name. Enforced here
 * rather than as a DB constraint because canonical names already legitimately
 * collide (two real people can share a name); it is only the chosen public
 * alias that should be unambiguous.
 */
async function assertDisplayNameFree(db: Db, displayName: string | null, playerId?: string): Promise<void> {
  if (!displayName) return;
  const clash = await db
    .select({ id: players.id })
    .from(players)
    .where(
      and(
        sql`lower(${players.displayName}) = ${displayName.toLowerCase()}`,
        eq(players.status, 'active'),
        playerId ? ne(players.id, playerId) : undefined,
      ),
    );
  if (clash.length > 0) {
    throw new TRPCError({ code: 'CONFLICT', message: `“${displayName}” is already taken by another player.` });
  }
}

/**
 * Details the reviewer may attach when the queue mints a new player. Every
 * field is optional and an omitted one means "keep what the bracket said", so
 * a one-click resolve still behaves exactly as it did before.
 */
const reviewDetailsSchema = z.object({
  canonicalName: z.string().trim().min(1).max(120).optional(),
  displayName: z.string().trim().min(1).max(80).nullable().optional(),
  companyCode: z.string().nullable().optional(),
  characters: characterSlugsSchema.optional(),
});

/** Swap the client's company *code* for the id the resolver stores. */
async function withResolvedCompany(
  db: Db,
  resolution:
    | { kind: 'linked_existing'; playerId: string }
    | { kind: 'created_new'; details?: z.infer<typeof reviewDetailsSchema> }
    | { kind: 'kept_separate'; details?: z.infer<typeof reviewDetailsSchema> },
): Promise<ReviewResolutionInput> {
  if (resolution.kind === 'linked_existing' || !resolution.details) return resolution;
  const { companyCode, ...rest } = resolution.details;
  await assertDisplayNameFree(db, rest.displayName ?? null);
  return {
    kind: resolution.kind,
    details: {
      ...rest,
      ...(companyCode !== undefined ? { companyId: await resolveCompanyId(db, companyCode) } : {}),
    },
  };
}

/** Details accepted when creating a player, from the registry or the queue. */
const playerDetailsSchema = z.object({
  canonicalName: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(80).nullable().default(null),
  companyCode: z.string().nullable().default(null),
  characters: characterSlugsSchema.default([]),
  /** Extra spellings to match future bracket entries on. */
  aliases: z.array(z.string().trim().min(1).max(120)).default([]),
});

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
          z.object({ kind: z.literal('created_new'), details: reviewDetailsSchema.optional() }),
          z.object({ kind: z.literal('kept_separate'), details: reviewDetailsSchema.optional() }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const resolution = await withResolvedCompany(ctx.db, input.resolution);
      const result = await resolveReviewItem(ctx.db, input.reviewItemId, resolution, ctx.user.id);
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
    const characters = await charactersByPlayer(ctx.db);
    return rows.map((row) => ({
      ...row,
      aliases: [...new Set(aliasesByPlayer.get(row.id) ?? [])].sort(),
      characters: characters.get(row.id) ?? [],
    }));
  }),

  /**
   * Mint a player directly, rather than only as a side effect of resolving a
   * bracket entry. The registry name is aliased on creation so the next import
   * of that spelling links silently instead of queueing for review.
   */
  createPlayer: adminProcedure.input(playerDetailsSchema).mutation(async ({ ctx, input }) => {
    const companyId = await resolveCompanyId(ctx.db, input.companyCode);
    await assertDisplayNameFree(ctx.db, input.displayName);

    const [created] = await ctx.db
      .insert(players)
      .values({
        canonicalName: input.canonicalName,
        companyId,
        displayName: input.displayName,
      })
      .returning({ id: players.id });
    const playerId = created!.id;

    for (const alias of [input.canonicalName, ...input.aliases]) {
      await ensureAlias(ctx.db, playerId, alias.toLowerCase(), companyId, 'manual');
    }
    await setPlayerCharacters(ctx.db, playerId, input.characters);
    return { playerId };
  }),

  updatePlayer: adminProcedure
    .input(
      z.object({
        playerId: z.uuid(),
        canonicalName: z.string().trim().min(1).max(120).optional(),
        companyCode: z.string().nullable().optional(),
        displayName: z.string().trim().min(1).max(80).nullable().optional(),
        characters: characterSlugsSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.canonicalName !== undefined) patch.canonicalName = input.canonicalName;
      if (input.displayName !== undefined) {
        await assertDisplayNameFree(ctx.db, input.displayName, input.playerId);
        patch.displayName = input.displayName;
      }
      if (input.companyCode !== undefined) {
        patch.companyId = await resolveCompanyId(ctx.db, input.companyCode);
      }
      await ctx.db.update(players).set(patch).where(eq(players.id, input.playerId));
      if (input.characters !== undefined) {
        await setPlayerCharacters(ctx.db, input.playerId, input.characters);
      }
      return { ok: true };
    }),

  addAlias: adminProcedure
    .input(z.object({ playerId: z.uuid(), alias: z.string().trim().min(1).max(120), companyCode: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const companyId = await resolveCompanyId(ctx.db, input.companyCode);
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
    // Player counts make the consequences of a rename or delete visible before
    // the admin commits to one.
    const counts = await ctx.db
      .select({ companyId: players.companyId, total: count() })
      .from(players)
      .where(eq(players.status, 'active'))
      .groupBy(players.companyId);
    const countByCompany = new Map(counts.map((row) => [row.companyId, row.total]));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      playerCount: countByCompany.get(row.id) ?? 0,
      aliases: aliases
        .filter((alias) => alias.companyId === row.id)
        .map((alias) => alias.aliasNorm)
        .sort(),
    }));
  }),

  /**
   * Create a company, or edit an existing one identified by `id`. Passing an
   * id is what makes the *code* editable — keying purely on code, as this
   * previously did, meant a typo'd code could only ever be abandoned.
   */
  upsertCompany: adminProcedure
    .input(
      z.object({
        id: z.uuid().optional(),
        code: z.string().trim().min(1).max(10),
        name: z.string().trim().min(1).max(80),
        aliases: z.array(z.string().trim().min(1).max(80)).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const code = input.code.toUpperCase();
      const clash = await ctx.db.select({ id: companies.id }).from(companies).where(eq(companies.code, code));
      if (clash.some((row) => row.id !== input.id)) {
        throw new TRPCError({ code: 'CONFLICT', message: `Company code ${code} is already in use.` });
      }

      let companyId: string;
      if (input.id) {
        const [updated] = await ctx.db
          .update(companies)
          .set({ code, name: input.name, updatedAt: new Date() })
          .where(eq(companies.id, input.id))
          .returning({ id: companies.id });
        if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Company not found.' });
        companyId = updated.id;
      } else {
        const [created] = await ctx.db
          .insert(companies)
          .values({ code, name: input.name })
          .returning({ id: companies.id });
        companyId = created!.id;
      }

      // Aliases are stored lowercased: matching is case-insensitive anyway, so
      // normalising on the way in stops "Atlas" and "atlas" becoming two rows
      // that the unique index treats as distinct.
      for (const alias of input.aliases) {
        await ctx.db
          .insert(companyAliases)
          .values({ companyId, aliasNorm: alias.toLowerCase() })
          .onConflictDoNothing();
      }
      return { companyId };
    }),

  removeCompanyAlias: adminProcedure
    .input(z.object({ companyId: z.uuid(), alias: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(companyAliases)
        .where(and(eq(companyAliases.companyId, input.companyId), eq(companyAliases.aliasNorm, input.alias)));
      return { ok: true };
    }),

  /**
   * Delete a company. Players and participants keep their rows and fall back to
   * "no company" (the FKs are ON DELETE SET NULL), so this is recoverable by
   * re-creating the company and re-tagging — but it does drop the aliases that
   * let sync recognise the tag, hence the count in the confirmation UI.
   */
  deleteCompany: adminProcedure.input(z.object({ companyId: z.uuid() })).mutation(async ({ ctx, input }) => {
    const [company] = await ctx.db.select().from(companies).where(eq(companies.id, input.companyId));
    if (!company) throw new TRPCError({ code: 'NOT_FOUND', message: 'Company not found.' });
    await ctx.db.delete(companies).where(eq(companies.id, input.companyId));
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
