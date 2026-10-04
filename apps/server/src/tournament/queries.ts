import { asc, eq } from 'drizzle-orm';
import {
  companies,
  eventOperators,
  nativeLiveHandoffs,
  players,
  user,
  eventPlans,
  type eventMatchAudit,
  type eventAttendanceAudit,
} from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { requireOperator } from '../event-operations/access';
import type { TrpcContext } from '../trpc/trpc';
import { nativeEvent, reportViews, type NativeEventApi } from './api';

export async function nativeOverview(api: NativeEventApi) {
  const { ctx, planId } = api;
  await requireOperator(ctx.db, planId, ctx.user!);
  const state = await api.state();
  const privateView = await api.runtime.snapshot(planId, true);
  const [handoff] = await ctx.db
    .select()
    .from(nativeLiveHandoffs)
    .where(eq(nativeLiveHandoffs.eventPlanId, planId));
  const imported = handoff!.baseline as {
    legacyAudit?: (typeof eventMatchAudit.$inferSelect)[];
    legacyAttendance?: (typeof eventAttendanceAudit.$inferSelect)[];
  };
  const audit = privateView.audit.flatMap((a) => {
    const matchId =
      'matchId' in a.command
        ? a.command.matchId
        : a.command.kind === 'review'
          ? state.reports.find(
              (r) => r.id === ('reportId' in a.command ? a.command.reportId : null),
            )?.matchId
          : null;
    return matchId
      ? [
          {
            id: `act:${a.sequence}`,
            eventPlanId: planId,
            matchId,
            userId: a.actorId.startsWith('guest:') ? null : a.actorId,
            guestSessionId: a.actorId.startsWith('guest:') ? a.actorId.slice(6) : null,
            action: a.kind,
            before: {},
            after: { command: a.command, correctionOf: a.correctionOf },
            createdAt: new Date(a.at),
          },
        ]
      : [];
  });
  const attendanceAudit = privateView.audit
    .filter((a) => !['score', 'review', 'progress', 'dispatch', 'matchControl'].includes(a.kind))
    .map((a) => ({
      id: `act:${a.sequence}`,
      eventPlanId: planId,
      userId: a.actorId,
      action: a.kind,
      details: a.command,
      createdAt: new Date(a.at),
    }));
  return {
    ...(await api.snapshot(true)),
    reports: reportViews(state),
    audit: [
      ...(imported.legacyAudit ?? []).map((a) => ({ ...a, createdAt: new Date(a.createdAt) })),
      ...audit,
    ]
      .slice(-100)
      .reverse(),
    attendanceAudit: [
      ...(imported.legacyAttendance ?? []).map((a) => ({ ...a, createdAt: new Date(a.createdAt) })),
      ...attendanceAudit,
    ]
      .slice(-100)
      .reverse(),
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
      .where(eq(eventOperators.eventPlanId, planId)),
    publication: privateView.publication,
    ratingIntents: await api.runtime.ratingStatus(planId),
  };
}
export async function nativeRoster(api: NativeEventApi) {
  const { ctx, planId } = api;
  await requireOperator(ctx.db, planId, ctx.user!);
  const state = await api.state();
  const profile = await ctx.db.select().from(players);
  const companyOptions = await ctx.db.select().from(companies).orderBy(asc(companies.name));
  return {
    attendees: state.entrants
      .filter((e) => e.availability !== 'withdrawn')
      .flatMap((e) => {
        const p = profile.find((p) => p.id === e.playerId);
        if (!p || p.status !== 'active') return [];
        const company = companyOptions.find((c) => c.id === p.companyId);
        return [
          {
            entryId: e.id,
            playerId: e.playerId,
            rawInput: e.name,
            cleanedName: e.name,
            division: e.division,
            canonicalName: p.canonicalName,
            displayName: p.displayName,
            companyCode: company?.code ?? null,
            companyName: company?.name ?? null,
            publicAlias: publicPlayerName(p),
          },
        ];
      }),
    companies: companyOptions.map((c) => ({ code: c.code, name: c.name })),
  };
}
export async function nativePublicEvents(
  ctx: TrpcContext,
  legacy: () => Promise<
    {
      id: string;
      name: string;
      eventDate: string;
      status: string;
      bracketMode: 'native' | 'challonge';
    }[]
  >,
) {
  const original = await legacy();
  if (!ctx.nativeRuntime) return original;
  const native = [];
  for (const plan of await ctx.db
    .select()
    .from(eventPlans)
    .where(eq(eventPlans.bracketMode, 'native'))) {
    const api = await nativeEvent(ctx, plan.id);
    if (!api) continue;
    const state = await api.state();
    if (!state.settings.published) continue;
    native.push({
      id: plan.id,
      name: state.baseline!.name,
      eventDate: new Date(state.baseline!.eventDate).toISOString(),
      status:
        state.lifecycle === 'finalized'
          ? 'complete'
          : state.lifecycle === 'cancelled'
            ? 'cancelled'
            : 'underway',
      bracketMode: 'native' as const,
    });
  }
  const owned = new Set((await ctx.db.select().from(nativeLiveHandoffs)).map((h) => h.eventPlanId));
  return [...original.filter((p) => !owned.has(p.id)), ...native]
    .sort(
      (a, b) =>
        Number(['complete', 'cancelled'].includes(a.status)) -
          Number(['complete', 'cancelled'].includes(b.status)) ||
        b.eventDate.localeCompare(a.eventDate),
    )
    .slice(0, 50);
}

export async function nativePlanList<T extends { id: string; status: string; entryCount: number }>(
  ctx: TrpcContext,
  rows: T[],
): Promise<T[]> {
  if (!ctx.nativeRuntime) return rows;
  const owned = new Set((await ctx.db.select().from(nativeLiveHandoffs)).map((h) => h.eventPlanId));
  return Promise.all(
    rows.map(async (row) => {
      if (!owned.has(row.id)) return row;
      const state = await ctx.nativeRuntime!.state(row.id);
      return {
        ...row,
        status:
          state.lifecycle === 'finalized'
            ? 'complete'
            : state.lifecycle === 'cancelled'
              ? 'cancelled'
              : 'underway',
        entryCount: state.entrants.length,
      };
    }),
  );
}
