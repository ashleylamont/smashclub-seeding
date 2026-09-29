import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  companies,
  eventAttendanceAudit,
  eventPlanEntries,
  eventPlans,
  eventWithdrawals,
  players,
  type Db,
} from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import type { SessionUser } from '../auth';
import { recomputePendingCandidates } from '../identity/candidates';
import { lockEvent, requireOperator } from './access';

/** Private roster data. Never add these fields to the public event snapshot. */
export async function attendeeRoster(db: Db, planId: string, actor: SessionUser) {
  await requireOperator(db, planId, actor);
  const [plan] = await db
    .select({ historicalAdoption: eventPlans.historicalAdoption })
    .from(eventPlans)
    .where(eq(eventPlans.id, planId));
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
  const companyOptions = await db
    .select({ code: companies.code, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.name));
  if (plan.historicalAdoption) return { attendees: [], companies: companyOptions };

  const rows = await db
    .select({
      entryId: eventPlanEntries.id,
      playerId: players.id,
      rawInput: eventPlanEntries.rawInput,
      cleanedName: eventPlanEntries.cleanedName,
      division: eventPlanEntries.assignedDivision,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
      companyCode: companies.code,
      companyName: companies.name,
    })
    .from(eventPlanEntries)
    .innerJoin(players, eq(eventPlanEntries.playerId, players.id))
    .leftJoin(companies, eq(players.companyId, companies.id))
    .leftJoin(
      eventWithdrawals,
      and(eq(eventWithdrawals.eventPlanId, planId), eq(eventWithdrawals.playerId, players.id)),
    )
    .where(
      and(
        eq(eventPlanEntries.eventPlanId, planId),
        eq(players.status, 'active'),
        isNull(eventWithdrawals.playerId),
      ),
    )
    .orderBy(asc(eventPlanEntries.sourceLineNumber));
  return {
    attendees: rows.map((row) => ({
      ...row,
      publicAlias: publicPlayerName(row),
    })),
    companies: companyOptions,
  };
}

export async function updateAttendee(
  db: Db,
  actor: SessionUser,
  input: {
    planId: string;
    playerId: string;
    canonicalName: string;
    displayName: string | null;
    companyCode: string | null;
  },
) {
  await requireOperator(db, input.planId, actor);
  const changed = await db.transaction(async (tx) => {
    await lockEvent(tx, input.planId);
    const [entry] = await tx
      .select({ id: eventPlanEntries.id })
      .from(eventPlanEntries)
      .innerJoin(players, eq(eventPlanEntries.playerId, players.id))
      .leftJoin(
        eventWithdrawals,
        and(
          eq(eventWithdrawals.eventPlanId, input.planId),
          eq(eventWithdrawals.playerId, players.id),
        ),
      )
      .where(
        and(
          eq(eventPlanEntries.eventPlanId, input.planId),
          eq(eventPlanEntries.playerId, input.playerId),
          eq(players.status, 'active'),
          isNull(eventWithdrawals.playerId),
        ),
      );
    if (!entry)
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'This player is not attending the event.',
      });

    const [current] = await tx
      .select()
      .from(players)
      .where(eq(players.id, input.playerId))
      .for('update');
    if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Player not found.' });
    const [company] = input.companyCode
      ? await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.code, input.companyCode))
      : [];
    if (input.companyCode && !company)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Company not found.' });
    if (input.displayName) {
      const clash = await tx
        .select({ id: players.id })
        .from(players)
        .where(
          and(
            sql`lower(${players.displayName}) = ${input.displayName.toLowerCase()}`,
            eq(players.status, 'active'),
            ne(players.id, input.playerId),
          ),
        )
        .limit(1);
      if (clash.length)
        throw new TRPCError({
          code: 'CONFLICT',
          message: `“${input.displayName}” is already taken by another player.`,
        });
    }
    await tx
      .update(players)
      .set({
        canonicalName: input.canonicalName,
        displayName: input.displayName,
        companyId: company?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(players.id, input.playerId));
    await tx.insert(eventAttendanceAudit).values({
      eventPlanId: input.planId,
      userId: actor.id,
      action: 'edit_player',
      details: {
        playerId: input.playerId,
        previous: {
          canonicalName: current.canonicalName,
          displayName: current.displayName,
          companyId: current.companyId,
        },
        updated: {
          canonicalName: input.canonicalName,
          displayName: input.displayName,
          companyId: company?.id ?? null,
        },
      },
    });
    return (
      current.canonicalName !== input.canonicalName || current.companyId !== (company?.id ?? null)
    );
  });
  if (changed) await recomputePendingCandidates(db);
  return { ok: true };
}
