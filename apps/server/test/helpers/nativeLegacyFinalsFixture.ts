import { expect } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { eventMatches, eventNativeBrackets, sets, type Db } from '@smashclub/db';
import {
  generateNativeBrackets,
  previewNativeBrackets,
} from '../../src/event-operations/nativeBrackets';
import { nativeDraw, pendingSlot } from '../../src/event-operations/nativeBracketSlots';
import { prepare, reportScore } from '../../src/event-operations/service';
import { getPlan, savePoolPlacements } from '../../src/event-planner/plans';
import { attendancePreview } from '../../src/tournament/attendance';
import { eventView, planView } from '../../src/tournament/views';
import { nativeStream, type NativeRuntime } from '../../src/tournament/runtime';
import type { Match, TournamentState } from '../../src/tournament/schemas';
import { appRouter } from '../../src/trpc/router';
import { loadEnv } from '../../src/env';
import { ChallongeClient } from '../../src/challonge/client';
import { RecomputeTrigger } from '../../src/recompute/trigger';
import { nativeAdmin, seedNativeDraft } from './nativeLiveFixture';

export async function verifyMixedLegacyFinalsRecovery(
  db: Db,
  createRuntime: () => Promise<NativeRuntime>,
) {
  let runtime = await createRuntime();
  try {
    const planId = await seedNativeDraft(db);
    await prepare(db, planId);
    const confirmed = [
      ['upper', 0],
      ['lower', 0],
      ['lower', 1],
    ] as const;
    for (const [division, poolIndex] of confirmed) {
      const poolMatches = await db
        .select()
        .from(eventMatches)
        .where(
          and(
            eq(eventMatches.eventPlanId, planId),
            eq(eventMatches.division, division),
            eq(eventMatches.poolIndex, poolIndex),
          ),
        );
      for (const match of poolMatches) await recordLegacyScore(db, match);
      const plan = (await getPlan(db, planId))!;
      const pool = plan.divisions
        .find((entry) => entry.division === division)!
        .pools.find((entry) => entry.poolIndex === poolIndex)!;
      await savePoolPlacements(db, planId, division, [
        {
          poolIndex,
          playerIdsInOrder: pool.members.map((member) => member.playerId),
          expectedMatchRevisions: pool.matchRevisions,
          expectedPlacementRevision: pool.placementRevision,
        },
      ]);
    }
    const review = await previewNativeBrackets(db, planId);
    await generateNativeBrackets(db, nativeAdmin, planId, review.revisionToken);
    const matches = () =>
      db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
    const played = (await matches()).find(
      (match) => match.division === 'lower' && match.stage !== 'group' && match.status === 'ready',
    )!;
    await recordLegacyScore(db, played);
    const sqlMatches = await matches();
    const rawBrackets = await db
      .select()
      .from(eventNativeBrackets)
      .where(eq(eventNativeBrackets.eventPlanId, planId));
    const mixed = rawBrackets.find(
      (bracket) => bracket.division === 'upper' && bracket.stage === 'main',
    )!;
    expect(mixed.entrantIds.some((id) => id.startsWith('pending:'))).toBe(true);
    expect(mixed.entrantIds.some((id) => !id.startsWith('pending:'))).toBe(true);

    await runtime.recover();
    const imported = await runtime.state(planId);
    const matchFacts = (state: typeof imported) =>
      state.matches
        .map(({ id, parent1Id, parent2Id, player1Id, player2Id, score1, score2, outcome }) => [
          id,
          parent1Id,
          parent2Id,
          player1Id,
          player2Id,
          score1,
          score2,
          outcome,
        ])
        .sort(([a], [b]) => a!.toString().localeCompare(b!.toString()));
    expect(matchFacts(imported)).toEqual(
      sqlMatches
        .map(
          ({
            id,
            parent1MatchId,
            parent2MatchId,
            player1Id,
            player2Id,
            score1,
            score2,
            outcome,
          }) => [id, parent1MatchId, parent2MatchId, player1Id, player2Id, score1, score2, outcome],
        )
        .sort(([a], [b]) => a!.toString().localeCompare(b!.toString())),
    );
    expect(
      imported.reports.some(
        (report) => report.matchId === played.id && report.status === 'approved',
      ),
    ).toBe(true);

    expect(imported.lifecycle).toBe('locked');
    await runtime.shutdown();
    runtime = await createRuntime();
    await runtime.recover();
    expect(await runtime.state(planId)).toEqual(imported);
    expect(await runtime.replay(planId)).toEqual(imported);

    const pending = imported.pools.find((pool) => pool.division === 'upper' && pool.index === 1)!;
    const caller = appRouter.createCaller({
      db,
      nativeRuntime: runtime,
      user: nativeAdmin,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
    const publicBefore = await eventView(db, imported);
    const mixedView = publicBefore.nativeBrackets.find(({ id }) => id === mixed.id)!;
    expect(mixedView.qualifierSlots).toEqual(
      expect.arrayContaining([expect.objectContaining({ poolId: pending.id, status: 'pending' })]),
    );
    expect(mixedView.qualifierSlots).toHaveLength(
      mixed.entrantIds.filter((id) => id.startsWith('pending:')).length,
    );
    expect(mixedView.complete).toBe(false);
    const waiting = imported.matches.find(
      (m) => m.bracketId === mixed.id && m.qualificationBlocks?.length,
    )!;
    await expect(scoreActMatch(runtime, planId, waiting)).rejects.toThrow(
      /Resolve the relevant pool qualification/,
    );
    expect(
      attendancePreview(imported, {
        action: 'withdraw',
        playerId: pending.entrantIds[0]!,
        reason: 'Fixture withdrawal',
      }).issues,
    ).toContain(
      'This pool has reserved finals places. Confirm its finishing order before changing its active roster.',
    );
    const entrant = imported.entrants.find(({ playerId }) => playerId === pending.entrantIds[0])!;
    await expect(
      runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'availability',
        playerId: entrant.playerId,
        expectedRevision: entrant.revision,
        availability: 'withdrawn',
        reason: 'Fixture withdrawal',
      }),
    ).rejects.toThrow(/pool has reserved finals places/);
    const overview = await caller.eventOps.overview({ planId });
    expect(overview.audit.some((entry) => entry.matchId === played.id)).toBe(true);

    for (const match of imported.matches.filter((m) => m.poolId === pending.id))
      await scoreActMatch(runtime, planId, match);
    const beforeOrder = await runtime.state(planId);
    const order = pending.entrantIds.toReversed();
    const plan = (await caller.admin.eventPlanner.plan({ planId }))!;
    const worksheet = plan.divisions
      .find(({ division }) => division === pending.division)!
      .pools.find(({ poolIndex }) => poolIndex === pending.index)!;
    const submitted = {
      planId,
      division: pending.division,
      pools: [
        {
          poolIndex: pending.index,
          playerIdsInOrder: order,
          expectedPlacementRevision: worksheet.placementRevision,
          expectedMatchRevisions: worksheet.matchRevisions,
        },
      ],
    };
    await caller.admin.eventPlanner.savePoolPlacements(submitted);
    const progressed = await runtime.state(planId);
    for (const bracket of rawBrackets) {
      const replacements = new Map(
        order.map((id, index) => [pendingSlot('upper', 1, index + 1), id]),
      );
      const seeds = bracket.entrantIds.map((id) => replacements.get(id) ?? id);
      expect(progressed.brackets.find((item) => item.id === bracket.id)!.entrantIds).toEqual(seeds);
      const slots = nativeDraw(seeds);
      const firstRound = progressed.matches.filter(
        (match) => match.bracketId === bracket.id && match.round === 1,
      );
      for (const match of firstRound) {
        expect([match.player1Id, match.player2Id]).toEqual(
          slots.slice(match.slot * 2, match.slot * 2 + 2),
        );
      }
    }
    expect(progressed.lifecycle).toBe(imported.lifecycle);
    const publicAfter = await eventView(db, progressed);
    const resolvedSlots = publicAfter.nativeBrackets.find(
      ({ id }) => id === mixed.id,
    )!.qualifierSlots!;
    expect(resolvedSlots).toHaveLength(mixedView.qualifierSlots!.length);
    expect(resolvedSlots.every(({ status, entrantId }) => status === 'resolved' && entrantId)).toBe(
      true,
    );
    expect(
      progressed.matches.find(({ id }) => id === waiting.id)?.qualificationBlocks,
    ).toBeUndefined();
    await expect(
      runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'placements',
        ...placementInput(progressed, pending.id, order.toReversed()),
      }),
    ).rejects.toThrow(/finals already exist/);
    const poolSet = beforeOrder.matches.find((match) => match.poolId === pending.id)!;
    await expect(scoreActMatch(runtime, planId, poolSet, true)).rejects.toThrow(
      /reviewed qualifier correction/,
    );
    expect(progressed.matches.find((match) => match.id === played.id)).toEqual(
      imported.matches.find((match) => match.id === played.id),
    );
    expect(
      progressed.matches.map(({ id, parent1Id, parent2Id }) => [id, parent1Id, parent2Id]),
    ).toEqual(imported.matches.map(({ id, parent1Id, parent2Id }) => [id, parent1Id, parent2Id]));
    expect(await runtime.replay(planId)).toEqual(progressed);

    const requestId = crypto.randomUUID();
    const repeatedScore = {
      kind: 'score' as const,
      matchId: poolSet.id,
      expectedRevision: poolSet.revision,
      score1: 2,
      score2: 0,
      outcome: 'played' as const,
    };
    const first = await runtime.command(nativeAdmin, planId, requestId, repeatedScore);
    const retry = await runtime.command(nativeAdmin, planId, requestId, repeatedScore);
    expect(retry.receipt).toEqual(first.receipt);
    const repeated = await runtime.state(planId);
    expect(repeated.pools.find(({ id }) => id === pending.id)).toEqual(
      progressed.pools.find(({ id }) => id === pending.id),
    );
    expect(repeated.brackets).toEqual(progressed.brackets);
    expect(repeated.matches.filter(({ bracketId }) => bracketId)).toEqual(
      progressed.matches.filter(({ bracketId }) => bracketId),
    );
    const openingSets = progressed.matches.filter((m) => m.bracketId === mixed.id && m.round === 1);
    expect(openingSets).toHaveLength(2);
    for (const match of openingSets) {
      expect(match.status).toBe('ready');
      await scoreActMatch(runtime, planId, match);
    }
    const beforeWithdrawal = await runtime.state(planId);
    const final = beforeWithdrawal.matches.find((m) => m.bracketId === mixed.id && m.round === 2)!;
    expect(final.status).toBe('ready');
    expect(final.player1Id).toBe(openingSets.find(({ id }) => id === final.parent1Id)!.player1Id);
    expect(final.player2Id).toBe(openingSets.find(({ id }) => id === final.parent2Id)!.player1Id);
    expect(beforeWithdrawal.matches.find((match) => match.id === played.id)).toEqual(
      imported.matches.find((match) => match.id === played.id),
    );

    const continued = await verifyLegacyWithdrawal(db, runtime, planId, pending.id);
    await runtime.shutdown();
    runtime = await createRuntime();
    await runtime.recover();
    const eventNames: string[] = [];
    await runtime.app.query({ stream: nativeStream(planId), after: -1 }, (event) => {
      eventNames.push(event.name);
    });
    const recovery = {
      continued,
      restarted: await runtime.state(planId),
      replayed: await runtime.replay(planId),
      eventNames,
    };
    await verifyLegacyPublication(db, runtime, planId);
    return recovery;
  } finally {
    await runtime.shutdown();
  }
}

async function verifyLegacyWithdrawal(
  db: Db,
  runtime: NativeRuntime,
  planId: string,
  poolId: string,
) {
  const drawn = await runtime.state(planId);
  // A different confirmed pool entered the imported bracket as fixed IDs.
  const lower = drawn.pools.find(({ division }) => division === 'lower')!;
  const lowerPoolSet = drawn.matches.find(({ poolId }) => poolId === lower.id)!;
  await scoreActMatch(runtime, planId, lowerPoolSet);
  const beforeWithdrawal = await runtime.state(planId);
  expect(beforeWithdrawal.pools).toEqual(drawn.pools);
  const pending = beforeWithdrawal.pools.find(({ id }) => id === poolId)!;
  const order = pending.order!;
  const withdrawal = {
    action: 'withdraw' as const,
    playerId: pending.entrantIds[0]!,
    reason: 'Player left after qualifying',
  };
  const preview = attendancePreview(beforeWithdrawal, withdrawal);
  expect(preview.allowed).toBe(true);
  const command = {
    kind: 'attendance' as const,
    ...withdrawal,
    revisionToken: preview.revisionToken,
    approveRedistribution: false,
  };
  const withdrawalRequestId = crypto.randomUUID();
  const firstWithdrawal = await runtime.command(nativeAdmin, planId, withdrawalRequestId, command);
  const withdrawalRetry = await runtime.command(nativeAdmin, planId, withdrawalRequestId, command);
  expect(withdrawalRetry.receipt).toEqual(firstWithdrawal.receipt);

  const lowerEntrant = beforeWithdrawal.entrants.find(
    ({ playerId }) => playerId === lower.order![0],
  )!;
  await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
    kind: 'availability',
    playerId: lowerEntrant.playerId,
    availability: 'withdrawn',
    expectedRevision: lowerEntrant.revision,
    reason: 'Player left during the finals',
  });
  const continued = await runtime.state(planId);
  expect(continued.pools).toEqual(beforeWithdrawal.pools);
  expect(continued.brackets).toEqual(beforeWithdrawal.brackets);
  for (const match of beforeWithdrawal.matches.filter(({ outcome }) => outcome !== null))
    expect(continued.matches.find(({ id }) => id === match.id)).toEqual(match);
  const event = await eventView(db, continued);
  expect(event.placements).toEqual((await eventView(db, beforeWithdrawal)).placements);
  expect(event.withdrawals.map(({ playerId }) => playerId)).toEqual(
    expect.arrayContaining([withdrawal.playerId, lowerEntrant.playerId]),
  );
  const retainedWorksheet = await planView(db, continued);
  for (const division of retainedWorksheet.divisions)
    expect(division).toMatchObject({
      fixedLegacyFinals: true,
      championship: [],
      consolation: null,
    });
  expect(
    retainedWorksheet.divisions
      .find(({ division }) => division === pending.division)!
      .pools.find(({ poolIndex }) => poolIndex === pending.index),
  ).toMatchObject({
    orderLockedReason: expect.stringContaining('confirmed places stay recorded'),
    members: expect.arrayContaining([
      expect.objectContaining({
        playerId: withdrawal.playerId,
        withdrawn: true,
        place: order.indexOf(withdrawal.playerId) + 1,
      }),
    ]),
  });
  await expect(
    runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'poolOrders',
      pools: [placementInput(continued, pending.id, order.toReversed())],
    }),
  ).rejects.toThrow(/Remove finals before changing qualifying orders/);
  return continued;
}

async function verifyLegacyPublication(db: Db, runtime: NativeRuntime, planId: string) {
  const initial = await runtime.state(planId);
  let closing = initial;
  for (let i = 0; i < closing.matches.length; i++) {
    const match = closing.matches.find(({ status }) => status === 'ready');
    if (!match) break;
    await scoreActMatch(runtime, planId, match);
    closing = await runtime.state(planId);
  }
  await runtime.command(nativeAdmin, planId, crypto.randomUUID(), { kind: 'finalize' });
  await runtime.drainReactions();
  const published = await runtime.state(planId);
  expect(published.result).toMatchObject({ version: 1, brackets: initial.brackets });
  expect(published.result).not.toHaveProperty('poolOrders');
  expect((await eventView(db, published)).placements).toEqual(
    (await eventView(db, initial)).placements,
  );
  const publishedSets = await db
    .select()
    .from(sets)
    .where(inArray(sets.tournamentId, published.publication!.tournamentIds));
  const byMatch = new Map(
    publishedSets.map((row) => [(row.raw as { eventMatchId: string }).eventMatchId, row]),
  );
  for (const match of initial.matches.filter(({ outcome }) => outcome === 'played'))
    expect(byMatch.get(match.id)).toMatchObject({
      p1PlayerId: match.player1Id,
      p2PlayerId: match.player2Id,
      winner: match.winnerId === match.player1Id ? 1 : 2,
      scoresCsv: `${match.score1}-${match.score2}`,
      excludedFromRatings: false,
    });
  expect(
    publishedSets.every(
      (row) => (row.raw as { outcome: string }).outcome === 'played' || row.excludedFromRatings,
    ),
  ).toBe(true);
}

export function placementInput(state: TournamentState, poolId: string, order?: string[]) {
  const pool = state.pools.find(({ id }) => id === poolId)!;
  return {
    poolId,
    order: order ?? pool.entrantIds,
    expectedRevision: pool.revision,
    matchRevisions: Object.fromEntries(
      state.matches.filter((m) => m.poolId === poolId).map((m) => [m.id, m.revision]),
    ),
  };
}

export function scoreActMatch(
  runtime: NativeRuntime,
  planId: string,
  match: Match,
  reverse = false,
) {
  return runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
    kind: 'score',
    matchId: match.id,
    expectedRevision: match.revision,
    score1: reverse ? 0 : 2,
    score2: reverse ? 2 : 0,
    outcome: 'played',
  });
}

function recordLegacyScore(db: Db, match: typeof eventMatches.$inferSelect) {
  return reportScore(db, nativeAdmin, {
    matchId: match.id,
    expectedRevision: match.revision,
    requestId: crypto.randomUUID(),
    score1: 2,
    score2: 0,
    outcome: 'played',
  });
}
