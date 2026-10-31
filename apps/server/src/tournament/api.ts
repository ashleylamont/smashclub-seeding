import { rollingFinals } from './qualifiers';
import { previewRollingFinals } from './finalsPreview';
import { poolOrderStatus } from './poolOrders';
import { sharedDispatch } from './dispatch';
import { isKnockout } from '@smashclub/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  eventPlans,
  eventMatches,
  eventScoreReports,
  nativeLiveHandoffs,
  players,
} from '@smashclub/db';
import type { TrpcContext } from '../trpc/trpc';
import { requireOperator } from '../event-operations/access';
import { attendancePreview } from './attendance';
import { drawFinals } from './brackets';
import { finalsToken } from './operations';
import { eventView, planView, matchRows } from './views';
import { TournamentConflict, hash, stableId, unconfirmedCall } from './facts';
import type { NativeRuntime } from './runtime';
import type { TournamentCommand, TournamentState } from './schemas';

// Cache only routing hints. Every hit is checked against current event ownership
// and membership below; permissions remain on the actual command path. Keep one
// bounded index per runtime so independent stores never share entity identities.
const entityIndexes = new WeakMap<
  NativeRuntime,
  Map<string, { match: Set<string>; report: Set<string> }>
>();
function rememberEntities(runtime: NativeRuntime, state: TournamentState) {
  if (!state.baseline) return;
  let index = entityIndexes.get(runtime);
  if (!index) {
    index = new Map();
    entityIndexes.set(runtime, index);
  }
  index.delete(state.baseline.planId);
  index.set(state.baseline.planId, {
    match: new Set(state.matches.map((m) => m.id)),
    report: new Set(state.reports.map((r) => r.id)),
  });
  if (index.size > 128) index.delete(index.keys().next().value!);
}

export async function nativeEvent(
  ctx: TrpcContext,
  planId: string,
  lock = false,
  intent?: { requestId?: string; [key: string]: unknown },
) {
  const [plan] = await ctx.db.select().from(eventPlans).where(eq(eventPlans.id, planId));
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
  if (plan.deletedAt) return null;
  if (plan.bracketMode !== 'native' || plan.historicalAdoption) return null;
  const [handoff] = await ctx.db
    .select()
    .from(nativeLiveHandoffs)
    .where(eq(nativeLiveHandoffs.eventPlanId, planId));
  if (
    !lock &&
    !handoff &&
    !plan.softLockedAt &&
    plan.status !== 'underway' &&
    plan.status !== 'complete'
  )
    return null;
  if (!ctx.nativeRuntime)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The Act tournament runtime is required for native live events.',
    });
  if (
    !handoff &&
    lock &&
    !ctx.user &&
    !plan.softLockedAt &&
    plan.status !== 'underway' &&
    plan.status !== 'complete'
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'An organiser must lock the pools before play.',
    });
  if (!handoff)
    await nativeTransport(() =>
      ctx.nativeRuntime!.lock(
        ctx.user ?? {
          id: 'native-migration',
          name: 'Native migration',
          role: 'admin',
          email: 'migration@internal',
        },
        planId,
      ),
    );
  await ctx.nativeRuntime.transfer(planId);
  return new NativeEventApi(ctx, ctx.nativeRuntime, planId, intent);
}
export async function nativeEntity(
  ctx: TrpcContext,
  id: string,
  kind: 'match' | 'report',
  intent?: { requestId?: string; [key: string]: unknown },
) {
  const table = kind === 'match' ? eventMatches : eventScoreReports;
  const [row] = await ctx.db
    .select({ planId: table.eventPlanId })
    .from(table)
    .where(eq(table.id, id));
  if (row) return nativeEvent(ctx, row.planId, true, intent);
  const index = ctx.nativeRuntime && entityIndexes.get(ctx.nativeRuntime);
  if (index)
    for (const [planId, ids] of index) {
      if (!ids[kind].has(id)) continue;
      const api = await nativeEvent(ctx, planId, false, intent);
      if (api) {
        const state = await api.state();
        if ((kind === 'match' ? state.matches : state.reports).some((entity) => entity.id === id))
          return api;
      }
      index.delete(planId);
    }
  if (ctx.nativeRuntime)
    for (const handoff of await ctx.db.select().from(nativeLiveHandoffs)) {
      const api = await nativeEvent(ctx, handoff.eventPlanId, false, intent);
      if (!api) continue;
      const state = await api!.state();
      if ((kind === 'match' ? state.matches : state.reports).some((row) => row.id === id))
        return api;
    }
  return null;
}
export async function nativeTransport<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TournamentConflict)
      throw new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
    throw error;
  }
}
export function reportViews(state: TournamentState) {
  return [...state.reports]
    .reverse()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      ...r,
      eventPlanId: state.baseline!.planId,
      userId: r.actorId.startsWith('guest:') ? null : r.actorId,
      guestSessionId: r.actorId.startsWith('guest:') ? r.actorId.slice(6) : null,
      reporterLabel: r.actorId.startsWith('guest:') ? 'Guest' : 'Player',
      createdAt: new Date(r.createdAt),
    }));
}
export class NativeEventApi {
  constructor(
    readonly ctx: TrpcContext,
    readonly runtime: NativeRuntime,
    readonly planId: string,
    readonly intent?: { requestId?: string; [key: string]: unknown },
  ) {}
  async state() {
    const state = await this.runtime.state(this.planId);
    rememberEntities(this.runtime, state);
    return state;
  }
  newId(kind: string) {
    return this.intent?.requestId
      ? stableId(`${this.planId}:${this.ctx.user?.id}:${kind}:${this.intent.requestId}`)
      : randomUUID();
  }
  execute(command: TournamentCommand, requestId: string = this.intent?.requestId ?? randomUUID()) {
    if (!this.ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
    return nativeTransport(() =>
      this.runtime.command(
        this.ctx.user!,
        this.planId,
        requestId,
        command,
        this.intent?.requestId ? hash(this.intent) : undefined,
      ),
    );
  }
  async snapshot(privateView = false) {
    const state = await this.state();
    if (!privateView && !state.settings.published)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This event is not published.' });
    return eventView(this.ctx.db, state, privateView);
  }
  async plan() {
    return planView(this.ctx.db, await this.state());
  }
  async report(input: {
    matchId: string;
    expectedRevision: number;
    requestId: string;
    score1: number;
    score2: number;
    outcome: 'played' | 'forfeit' | 'bye';
    winnerId?: string;
  }) {
    const previous = reportViews(await this.state()).find(
      (r) => r.actorId === this.ctx.user!.id && r.requestId === input.requestId,
    );
    if (previous) {
      if (
        previous.matchId !== input.matchId ||
        previous.submittedRevision !== input.expectedRevision ||
        previous.outcome !== input.outcome ||
        previous.score1 !== (input.outcome === 'forfeit' ? null : input.score1) ||
        previous.score2 !== (input.outcome === 'forfeit' ? null : input.score2) ||
        (input.winnerId && previous.winnerId !== input.winnerId)
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Request identifier already used for a different score.',
        });
      return previous;
    }
    if (input.outcome === 'bye')
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Byes are determined by the recorded draw.',
      });
    const response = await this.execute(
      {
        ...input,
        kind: 'score',
        outcome: input.outcome,
        score1: input.outcome === 'forfeit' ? null : input.score1,
        score2: input.outcome === 'forfeit' ? null : input.score2,
      },
      input.requestId,
    );
    const state = await this.state();
    return reportViews(state).find((r) => r.id === response.receipt.reportId)!;
  }
  async updateMatch(input: {
    matchId: string;
    expectedRevision: number;
    status: 'ready' | 'playing' | 'blocked';
    stationId?: string | null;
    blockedReason?: string | null;
    expectedResourceRevision?: number;
  }) {
    const state = await this.state();
    const m = state.matches.find((m) => m.id === input.matchId);
    if (!m) throw new TRPCError({ code: 'NOT_FOUND', message: 'Match not found.' });
    const expectedResourceRevision =
      input.expectedResourceRevision ?? state.settings.resourceRevision;
    if (input.status === 'playing') {
      const view = await this.snapshot(true);
      const available = view.matches.find((row) => row.id === input.matchId)!.availability;
      const stationId =
        input.stationId === undefined
          ? sharedDispatch(state)
            ? null
            : (m.stationId ?? available.eligibleStationIds[0] ?? null)
          : input.stationId;
      await this.execute({
        kind: 'dispatch',
        matchId: m.id,
        stationId,
        expectedRevision: input.expectedRevision,
        expectedResourceRevision,
      });
    } else
      await this.execute({
        kind: 'matchControl',
        matchId: m.id,
        status: input.status,
        stationId: input.stationId === undefined ? m.stationId : input.stationId,
        reason: input.blockedReason ?? null,
        expectedRevision: input.expectedRevision,
        expectedResourceRevision,
      });
    return matchRows(await this.state()).find((row) => row.id === input.matchId)!;
  }
  async review(reportId: string, approve: boolean) {
    const state = await this.state();
    const r = state.reports.find((r) => r.id === reportId);
    if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found.' });
    await requireOperator(this.ctx.db, this.planId, this.ctx.user!);
    if (r.status === 'pending')
      await this.execute({
        kind: 'review',
        reportId,
        approve,
        expectedRevision: state.matches.find((m) => m.id === r.matchId)!.revision,
      });
    return reportViews(await this.state()).find((r) => r.id === reportId)!;
  }
  async previewFinals() {
    const state = await this.state();
    if (rollingFinals(state)) return previewRollingFinals(state);
    const trial = structuredClone(state);
    const replacing = Boolean(state.brackets.length);
    trial.brackets = [];
    trial.matches = trial.matches.filter((m) => !m.bracketId);
    const issues: string[] = [];
    if (isKnockout(state.baseline!.structure))
      issues.push('Knockout brackets are fixed at draw lock.');
    if (state.lifecycle !== 'locked') issues.push('The event is not open.');
    if (
      state.matches.some(
        (m) =>
          m.bracketId && (m.started || (m.outcome && !['bye', 'no_contest'].includes(m.outcome))),
      )
    )
      issues.push('Finals have actual play and cannot be reset.');
    if (state.matches.some((m) => m.bracketId && unconfirmedCall(m)))
      issues.push('Return untaken finals calls before changing their draw.');
    const resetIssues = [...issues];
    if (!replacing) resetIssues.push('No finals exist.');
    try {
      drawFinals(trial, {
        id: randomUUID(),
        requestId: 'preview',
        actorId: this.ctx.user!.id,
        operator: true,
        at: Date.now(),
        command: { kind: 'drawFinals' },
      });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Cannot draw finals.');
    }
    return {
      allowed: !issues.length,
      issues,
      resetAllowed: !resetIssues.length,
      resetIssues,
      replacing,
      poolOrders: state.pools.map((p) => ({
        poolId: p.id,
        division: p.division,
        poolIndex: p.index,
        ...poolOrderStatus(state, p),
      })),
      revisionToken: finalsToken(state),
      brackets: trial.brackets.map((b) => ({
        ...b,
        roundOne: trial.matches
          .filter((m) => m.bracketId === b.id && m.round === 1)
          .map((m) => ({ player1Id: m.player1Id, player2Id: m.player2Id })),
      })),
    };
  }
  async previewAttendance(input: Parameters<typeof attendancePreview>[1]) {
    return attendancePreview(await this.state(), input);
  }
  async attendance(
    input: Parameters<typeof attendancePreview>[1] & {
      revisionToken: string;
      reason?: string;
      approveRedistribution?: boolean;
    },
  ) {
    let entrant: Extract<TournamentCommand, { kind: 'attendance' }>['entrant'];
    if (input.action === 'add') {
      const [p] = await this.ctx.db.select().from(players).where(eq(players.id, input.playerId));
      if (!p || p.status !== 'active')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose an active player.' });
      entrant = {
        id: randomUUID(),
        name: p.canonicalName,
        snapshotRank: null,
        snapshotScore: null,
      };
    }
    const preview = await this.previewAttendance(input);
    await this.execute({
      ...input,
      kind: 'attendance',
      reason:
        input.action === 'restore' ? (input.reason?.trim() ?? '') : (input.reason ?? input.action),
      approveRedistribution: input.approveRedistribution ?? false,
      entrant,
    });
    return {
      applied: true,
      addedMatches: preview.addedMatches,
      affectedMatches: preview.affectedMatches.length,
    };
  }
}
