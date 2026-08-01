import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { companies, playerClaims, players } from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { charactersByPlayer, characterSlugsSchema, setPlayerCharacters } from '../../players/characters';
import { authedProcedure, router } from '../trpc';

/**
 * Every self-service edit below is gated on the caller holding an *approved*
 * claim on the player they are editing — a pending claim is not yet proof of
 * anything, so it grants nothing.
 */
async function assertApprovedClaim(db: Db, userId: string, playerId: string): Promise<void> {
  const approved = await db
    .select({ id: playerClaims.id })
    .from(playerClaims)
    .where(
      and(
        eq(playerClaims.userId, userId),
        eq(playerClaims.playerId, playerId),
        eq(playerClaims.status, 'approved'),
      ),
    );
  if (approved.length === 0) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You have not claimed this player.' });
  }
}

export const meRouter = router({
  /**
   * Authoritative identity and role for the signed-in caller. The client gates
   * admin navigation on this rather than on the auth session, because role
   * promotion from ADMIN_EMAILS is applied server-side.
   */
  whoami: authedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    role: ctx.user.role,
  })),

  /** The caller's claim state (live claim + history). */
  claims: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: playerClaims.id,
        playerId: playerClaims.playerId,
        status: playerClaims.status,
        note: playerClaims.note,
        createdAt: playerClaims.createdAt,
        resolvedAt: playerClaims.resolvedAt,
        canonicalName: players.canonicalName,
        displayName: players.displayName,
        companyCode: companies.code,
      })
      .from(playerClaims)
      .innerJoin(players, eq(playerClaims.playerId, players.id))
      .leftJoin(companies, eq(players.companyId, companies.id))
      .where(eq(playerClaims.userId, ctx.user.id))
      .orderBy(desc(playerClaims.createdAt));
    const characters = await charactersByPlayer(
      ctx.db,
      rows.map((row) => row.playerId),
    );
    return rows.map((row) => ({
      ...row,
      playerName: publicPlayerName(row),
      characters: characters.get(row.playerId) ?? [],
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
  }),

  requestClaim: authedProcedure
    .input(z.object({ playerId: z.uuid(), note: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const [player] = await ctx.db
        .select()
        .from(players)
        .where(and(eq(players.id, input.playerId), eq(players.status, 'active')));
      if (!player) throw new TRPCError({ code: 'NOT_FOUND', message: 'Player not found.' });

      const live = await ctx.db
        .select({ id: playerClaims.id })
        .from(playerClaims)
        .where(and(eq(playerClaims.userId, ctx.user.id), inArray(playerClaims.status, ['pending', 'approved'])));
      if (live.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You already have a live claim. Withdraw it before claiming another player.',
        });
      }

      const [claim] = await ctx.db
        .insert(playerClaims)
        .values({ userId: ctx.user.id, playerId: input.playerId, note: input.note ?? null })
        .returning({ id: playerClaims.id });
      return { claimId: claim!.id };
    }),

  withdrawClaim: authedProcedure.input(z.object({ claimId: z.uuid() })).mutation(async ({ ctx, input }) => {
    const [claim] = await ctx.db
      .select()
      .from(playerClaims)
      .where(and(eq(playerClaims.id, input.claimId), eq(playerClaims.userId, ctx.user.id)));
    if (!claim) throw new TRPCError({ code: 'NOT_FOUND' });
    if (claim.status !== 'pending' && claim.status !== 'approved') {
      throw new TRPCError({ code: 'CONFLICT', message: 'Only live claims can be withdrawn.' });
    }
    await ctx.db
      .update(playerClaims)
      .set({ status: 'revoked', resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(playerClaims.id, input.claimId));
    return { ok: true };
  }),

  /**
   * Any approved claimant may set the player's public alias — the name the
   * leaderboard shows instead of the registry's canonical one. Null clears it
   * and falls back to the canonical name.
   */
  updateDisplayName: authedProcedure
    .input(z.object({ playerId: z.uuid(), displayName: z.string().trim().min(1).max(80).nullable() }))
    .mutation(async ({ ctx, input }) => {
      await assertApprovedClaim(ctx.db, ctx.user.id, input.playerId);

      // Two players publishing the same alias would make the board ambiguous,
      // so the name is claimed first-come. Canonical names may still collide —
      // real people share names — it is only the chosen alias that is unique.
      if (input.displayName) {
        const clash = await ctx.db
          .select({ id: players.id })
          .from(players)
          .where(
            and(
              sql`lower(${players.displayName}) = ${input.displayName.toLowerCase()}`,
              eq(players.status, 'active'),
              ne(players.id, input.playerId),
            ),
          );
        if (clash.length > 0) {
          throw new TRPCError({ code: 'CONFLICT', message: `“${input.displayName}” is already taken.` });
        }
      }

      await ctx.db
        .update(players)
        .set({ displayName: input.displayName, updatedAt: new Date() })
        .where(eq(players.id, input.playerId));
      return { ok: true };
    }),

  /** Approved claimants keep their own mains current. */
  updateCharacters: authedProcedure
    .input(z.object({ playerId: z.uuid(), characters: characterSlugsSchema }))
    .mutation(async ({ ctx, input }) => {
      await assertApprovedClaim(ctx.db, ctx.user.id, input.playerId);
      await setPlayerCharacters(ctx.db, input.playerId, input.characters);
      return { ok: true };
    }),
});
