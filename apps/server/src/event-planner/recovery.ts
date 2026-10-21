import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  eventPlans,
  eventMatches,
  eventScoreReports,
  eventPlanEntries,
  eventPlanBrackets,
  nativeResultPublications,
  tournaments,
  type Db,
} from '@smashclub/db';
import type { TrpcContext } from '../trpc/trpc';
import { nativeEvent, nativeTransport } from '../tournament/api';
import { hash, stableId } from '../tournament/facts';
import { applyPlanRetirement, type PlanRetirement } from './retirement';

const requireAdmin = (ctx: TrpcContext) => {
  if (ctx.user?.role !== 'admin')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access required.' });
  return ctx.user;
};
async function planningFacts(db: Db, planId: string) {
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId));
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
  const entries = await db
    .select()
    .from(eventPlanEntries)
    .where(eq(eventPlanEntries.eventPlanId, planId))
    .orderBy(asc(eventPlanEntries.id));
  const brackets = await db
    .select({
      id: eventPlanBrackets.id,
      challongeSlug: eventPlanBrackets.challongeSlug,
      tournamentId: eventPlanBrackets.tournamentId,
      provider: tournaments.provider,
    })
    .from(eventPlanBrackets)
    .leftJoin(tournaments, eq(eventPlanBrackets.tournamentId, tournaments.id))
    .where(eq(eventPlanBrackets.eventPlanId, planId))
    .orderBy(asc(eventPlanBrackets.id));
  const publications = await db
    .select()
    .from(nativeResultPublications)
    .where(eq(nativeResultPublications.eventPlanId, planId))
    .orderBy(asc(nativeResultPublications.resultId));
  const matches = await db
    .select()
    .from(eventMatches)
    .where(eq(eventMatches.eventPlanId, planId))
    .orderBy(asc(eventMatches.id));
  const reports = await db
    .select()
    .from(eventScoreReports)
    .where(eq(eventScoreReports.eventPlanId, planId))
    .orderBy(asc(eventScoreReports.id));
  return { plan, entries, brackets, publications, matches, reports };
}
export async function previewPlanRecovery(ctx: TrpcContext, planId: string) {
  requireAdmin(ctx);
  const facts = await planningFacts(ctx.db, planId);
  const api = facts.plan.deletedAt ? null : await nativeEvent(ctx, planId);
  const state = api ? await api.state() : null;
  return {
    planId,
    name: facts.plan.name,
    retirement: facts.plan.retirement,
    token: hash(JSON.parse(JSON.stringify({ facts, sequence: state?.sequence ?? null }))),
    sequence: state?.sequence ?? null,
    entrants: state?.entrants.length ?? facts.entries.length,
    recordedMatches:
      state?.matches.filter(
        (m) => m.started || m.outcome || m.liveScore1 !== null || m.liveScore2 !== null,
      ).length ??
      facts.matches.filter(
        (m) =>
          m.status === 'playing' ||
          m.outcome ||
          m.score1 !== null ||
          m.score2 !== null ||
          m.liveScore1 !== null ||
          m.liveScore2 !== null,
      ).length,
    pendingReports: (state?.reports ?? facts.reports).filter((r) => r.status === 'pending').length,
    publishedBrackets: facts.publications.reduce((n, p) => n + p.tournamentIds.length, 0),
    hasSealedResults: Boolean(state?.result || facts.publications.length),
    linkedExternalBrackets: facts.brackets.filter(
      (b) => (b.challongeSlug || b.tournamentId) && b.provider !== 'native',
    ).length,
  };
}
type RecoveryRequest = {
  planId: string;
  operation: 'reset' | 'delete';
  token: string;
  withdrawResults: boolean;
  reason: string;
  requestId?: string;
};
function sameRequest(
  saved: PlanRetirement,
  input: RecoveryRequest,
  actorId: string,
  requestId: string,
) {
  if (
    saved.requestId !== requestId ||
    saved.actorId !== actorId ||
    saved.operation !== input.operation ||
    saved.withdrawResults !== input.withdrawResults ||
    saved.reason !== input.reason
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This event was already retired by another request.',
    });
}
export async function recoverPlan(ctx: TrpcContext, input: RecoveryRequest) {
  const actor = requireAdmin(ctx);
  const requestId = input.requestId ?? randomUUID();
  const { plan } = await planningFacts(ctx.db, input.planId);
  if (plan.retirement) {
    sameRequest(plan.retirement, input, actor.id, requestId);
    return plan.retirement;
  }
  const api = await nativeEvent(ctx, input.planId);
  const state = api ? await api.state() : null;
  if (state?.retirement) {
    sameRequest(state.retirement, input, actor.id, requestId);
    return nativeTransport(() =>
      applyPlanRetirement(ctx.db, input.planId, state.retirement!, state.entrants),
    );
  }
  const preview = await previewPlanRecovery(ctx, input.planId);
  if (preview.token !== input.token)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The event changed. Review the recovery preview again.',
    });
  if (input.withdrawResults && preview.linkedExternalBrackets)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Linked Challonge results are retained; manage those tournaments separately.',
    });
  const replacementPlanId =
    input.operation === 'reset'
      ? stableId(`${input.planId}:recovery:${actor.id}:${requestId}`)
      : null;
  if (api) {
    await nativeTransport(() =>
      ctx.nativeRuntime!.command(actor, input.planId, requestId, {
        kind: 'retire',
        operation: input.operation,
        replacementPlanId,
        withdrawResults: input.withdrawResults,
        reason: input.reason,
        expectedSequence: preview.sequence!,
      }),
    );
    const retired = await api.state();
    return nativeTransport(() =>
      applyPlanRetirement(ctx.db, input.planId, retired.retirement!, retired.entrants),
    );
  }
  return ctx.db.transaction(async (tx) => {
    await tx.select().from(eventPlans).where(eq(eventPlans.id, input.planId)).for('update');
    // SQL-owned drafts and Challonge plans use the same row lock as their edits.
    const latest = await previewPlanRecovery({ ...ctx, db: tx }, input.planId);
    if (latest.token !== input.token || latest.sequence !== null)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The event changed. Review the recovery preview again.',
      });
    return applyPlanRetirement(tx, input.planId, {
      requestId,
      actorId: actor.id,
      at: Date.now(),
      operation: input.operation,
      replacementPlanId,
      withdrawResults: input.withdrawResults,
      reason: input.reason,
    });
  });
}
