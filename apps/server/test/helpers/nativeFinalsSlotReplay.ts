import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventOperationSettings, eventPlans, players } from '@smashclub/db';
import type { postgresCluster } from './postgres';
import { nativeAdmin, seedNativeDraft } from './nativeLiveFixture';
import type { NativeRuntime } from '../../src/tournament/runtime';
import { appRouter } from '../../src/trpc/router';
import { loadEnv } from '../../src/env';
import { ChallongeClient } from '../../src/challonge/client';
import { RecomputeTrigger } from '../../src/recompute/trigger';
import type { Match, TournamentCommand, TournamentState } from '../../src/tournament/schemas';
import type { SessionUser } from '../../src/auth';

export function nativeFinalsSlotReplayFixture(
  pg: Awaited<ReturnType<typeof postgresCluster>>,
  runtime: NativeRuntime,
) {
  function caller(user: SessionUser | null = nativeAdmin) {
    return appRouter.createCaller({
      db: pg.db,
      nativeRuntime: runtime,
      user,
      env: loadEnv({ DATABASE_URL: pg.connectionString, NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(pg.db),
    });
  }

  function score(match: Match, winningEntrant: string, requestId = crypto.randomUUID()) {
    return {
      matchId: match.id,
      expectedRevision: match.revision,
      requestId,
      outcome: 'played' as const,
      score1: winningEntrant === match.player1Id ? 2 : 1,
      score2: winningEntrant === match.player1Id ? 1 : 2,
    };
  }

  async function draftDoubles(consolation: boolean) {
    const members = await pg.db
      .insert(players)
      .values(
        Array.from({ length: 32 }, (_, i) => ({
          canonicalName: `Replay pair member ${i} ${crypto.randomUUID()}`,
          displayName: `Member ${i}`,
        })),
      )
      .returning();
    const { admin } = caller();
    const { planId } = await admin.eventPlanner.createPlan({
      competitionFormat: 'doubles',
      bracketMode: 'native',
      structure: 'dual_division',
      structureOptions: { roundRobinMeetings: 1, consolation },
      name: 'Pair finals replay',
      eventDate: '2026-10-03T00:00:00Z',
      upperTargetSize: 8,
      rows: [],
    });
    for (let i = 0; i < 16; i++)
      await admin.eventPlanner.addDoublesPair({
        planId,
        playerId: members[i * 2]!.id,
        partnerPlayerId: members[i * 2 + 1]!.id,
        teamName: `Pair ${i}`,
      });
    await admin.eventPlanner.freezeRoster({ planId });
    await admin.eventPlanner.generatePools({ planId });
    await pg.db.insert(eventOperationSettings).values({
      eventPlanId: planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    return planId;
  }

  async function substituteLowerPair(planId: string, state: TournamentState) {
    const entrant = state.entrants.find((e) => e.division === 'lower')!;
    const [incoming] = await pg.db
      .insert(players)
      .values({
        canonicalName: 'Mixed journal substitute',
        displayName: 'Mixed substitute',
      })
      .returning();
    const request = {
      planId,
      entrantId: entrant.id,
      outgoingPlayerId: entrant.memberPlayerIds![1]!,
      incomingPlayerId: incoming!.id,
      reason: 'Original lower pair member unavailable before play',
    };
    const { eventOps } = caller();
    const preview = await eventOps.previewDoublesSubstitution(request);
    expect(preview.allowed).toBe(true);
    await eventOps.applyDoublesSubstitution({
      ...request,
      requestId: 'substitution-before-finals-replay',
      revisionToken: preview.revisionToken,
    });
    return {
      entrantId: entrant.id,
      memberPlayerIds: [entrant.memberPlayerIds![0]!, incoming!.id],
    };
  }

  async function prepare({
    consolation = false,
    doubles = false,
    consolationBye = false,
    substituteBeforePlay = false,
    beforePoolPlay,
  }: {
    consolation?: boolean;
    doubles?: boolean;
    consolationBye?: boolean;
    substituteBeforePlay?: boolean;
    beforePoolPlay?: (planId: string) => Promise<void>;
  } = {}) {
    const planId = doubles ? await draftDoubles(consolation) : await seedNativeDraft(pg.db);
    if (!doubles)
      await pg.db
        .update(eventPlans)
        .set({
          structure: 'dual_division',
          structureOptions: { roundRobinMeetings: 1, consolation },
        })
        .where(eq(eventPlans.id, planId));
    const { eventOps } = caller();
    const state = () => runtime.state(planId);
    const send = (command: TournamentCommand, requestId = crypto.randomUUID()) =>
      eventOps.live.command({ planId, requestId, command });
    const report = (match: Match, winner: string) => eventOps.reportScore(score(match, winner));
    await eventOps.softLockPools({ planId, confirm: true });
    const substitution = substituteBeforePlay
      ? await substituteLowerPair(planId, await state())
      : null;
    await beforePoolPlay?.(planId);
    const initial = await state();
    for (const match of initial.matches) {
      const pool = initial.pools.find(({ id }) => id === match.poolId)!;
      await report(
        match,
        pool.entrantIds.find((id) => [match.player1Id, match.player2Id].includes(id))!,
      );
    }
    if (consolationBye) {
      const otherPool = initial.pools.find(
        (pool) => pool.division === 'upper' && pool.index === 1,
      )!;
      const withdrawal = {
        planId,
        action: 'withdraw' as const,
        playerId: otherPool.entrantIds.at(-1)!,
      };
      const preview = await eventOps.previewAttendance(withdrawal);
      if (!preview.allowed) throw new Error(preview.issues.join(' '));
      await eventOps.applyAttendance({ ...withdrawal, revisionToken: preview.revisionToken });
    }
    const drawArgs = { planId, seedPolicy: 'pool_place_whr_v1' as const };
    const preview = await eventOps.native.preview(drawArgs);
    await eventOps.native.generate({
      ...drawArgs,
      revisionToken: preview.revisionToken,
      requestId: crypto.randomUUID(),
    });
    const drawn = await state();
    const bracket = drawn.brackets.find((b) => b.division === 'upper' && b.stage === 'main')!;
    const place = bracket.qualifierSlots!.find(({ place }) => place === 2)!;
    const pool = drawn.pools.find(({ id }) => id === place.poolId)!;
    expect(pool.order).toHaveLength(4);
    const [first, alice, bea, fourth] = pool.order!;
    const original = drawn.matches.find(
      (m) =>
        m.bracketId === bracket.id && m.round === 1 && [m.player1Id, m.player2Id].includes(alice!),
    )!;
    const chris = original.player1Id === alice ? original.player2Id! : original.player1Id!;
    const sibling = drawn.matches.find(
      (m) => m.bracketId === bracket.id && m.round === 1 && m.id !== original.id,
    )!;
    const downstream = drawn.matches.find(
      (m) => m.parent1Id === original.id || m.parent2Id === original.id,
    )!;
    const source = drawn.matches.find(
      (m) =>
        m.poolId === pool.id &&
        [m.player1Id, m.player2Id].includes(alice!) &&
        [m.player1Id, m.player2Id].includes(bea!),
    )!;
    const { requestId: _, outcome: __, ...reviewInput } = score(source, bea!);
    const review = () => eventOps.live.previewFinalsSlotReplay({ planId, ...reviewInput });
    const reviewedCommand = (revisionToken: string) => ({
      kind: 'replayFinalsSlotV1' as const,
      ...reviewInput,
      revisionToken,
      reason: 'Checked score sheet with both entrants',
    });
    return {
      planId,
      eventOps,
      state,
      send,
      report,
      review,
      reviewedCommand,
      original,
      sibling,
      downstream,
      source,
      pool,
      bracket,
      alice: alice!,
      bea: bea!,
      chris,
      first,
      fourth,
      reviewInput,
      substitution,
    };
  }

  const lowerFacts = (state: TournamentState) => {
    const matches = state.matches.filter((m) => m.division === 'lower');
    return {
      matches,
      pools: state.pools.filter((p) => p.division === 'lower'),
      brackets: state.brackets.filter((b) => b.division === 'lower'),
      reports: state.reports.filter((r) => matches.some((m) => m.id === r.matchId)),
      stations: state.stations,
    };
  };

  async function finish(
    context: Awaited<ReturnType<typeof prepare>>,
    preferredWinner: string,
    replacementMatchId: string,
  ) {
    const replacement = (await context.state()).matches.find(
      ({ id }) => id === replacementMatchId,
    )!;
    await context.report(replacement, preferredWinner);
    const downstream = (await context.state()).matches.find(
      ({ id }) => id === context.downstream.id,
    )!;
    expect([downstream.player1Id, downstream.player2Id]).toContain(preferredWinner);
    expect([downstream.player1Id, downstream.player2Id]).not.toContain(context.alice);
    for (;;) {
      const ready = (await context.state()).matches.find((m) => m.status === 'ready');
      if (!ready) break;
      await context.report(ready, ready.player1Id!);
    }
    await context.eventOps.native.finalize({ planId: context.planId });
    return context.state();
  }

  return { caller, score, prepare, lowerFacts, finish };
}
