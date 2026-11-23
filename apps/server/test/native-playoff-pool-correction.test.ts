import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import { players, sets, tournamentParticipants, user, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { reviewPlayoffPoolScore } from '../src/tournament/poolGameCorrection';

describe('playoff-neutral native pool corrections', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values(nativeAdmin);
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });
  const caller = () =>
    appRouter.createCaller({
      db,
      user: nativeAdmin,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  async function draft() {
    const entrants = await db
      .insert(players)
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          canonicalName: `Round robin ${crypto.randomUUID()}`,
          displayName: `Player ${index + 1}`,
        })),
      )
      .returning();
    const { planId } = await caller().admin.eventPlanner.createPlan({
      name: 'Round robin with playoffs',
      eventDate: '2026-10-22T12:00:00Z',
      structure: 'round_robin_finals',
      structureOptions: { playoffSize: 2, consolation: false },
      rows: entrants.map((player, index) => ({
        lineNumber: index + 1,
        rawInput: player.canonicalName,
        cleanedName: player.canonicalName,
        companyId: null,
        playerId: player.id,
        resolutionMethod: 'manual',
      })),
    });
    await caller().admin.eventPlanner.freezeRoster({ planId });
    await caller().admin.eventPlanner.generatePools({ planId });
    await caller().eventOps.softLockPools({ planId, confirm: true });
    return planId;
  }

  async function playedRoundRobinPlayoff(
    combined = true,
    beforeFinal?: (planId: string) => Promise<void>,
  ) {
    const planId = await draft();
    const initial = await runtime.state(planId);
    const order = initial.pools[0]!.entrantIds;
    const score = (match: (typeof initial.matches)[number], winnerId: string) => ({
      matchId: match.id,
      expectedRevision: match.revision,
      score1: match.player1Id === winnerId ? 2 : 0,
      score2: match.player2Id === winnerId ? 2 : 0,
      outcome: 'played' as const,
    });
    for (const match of initial.matches) {
      const winnerId = order.find((id) => [match.player1Id, match.player2Id].includes(id))!;
      await caller().eventOps.reportScore({
        ...score(match, winnerId),
        requestId: crypto.randomUUID(),
      });
    }
    const seedPolicy = combined ? 'pool_place_whr_v1' : undefined;
    const preview = await caller().eventOps.native.preview({ planId, seedPolicy });
    await caller().eventOps.native.generate({
      planId,
      seedPolicy,
      revisionToken: preview.revisionToken,
    });
    const final = (await runtime.state(planId)).matches.find((match) => match.bracketId)!;
    await beforeFinal?.(planId);
    await caller().eventOps.reportScore({
      ...score(final, order[0]!),
      requestId: crypto.randomUUID(),
    });
    const played = await runtime.state(planId);
    expect(played.brackets[0]!.entrantIds).toEqual(order.slice(0, 2));
    const correction = (higher: number, lower: number) => {
      const match = played.matches.find((m) =>
        [order[higher]!, order[lower]!].every((id) => [m.player1Id, m.player2Id].includes(id)),
      )!;
      return score(match, order[lower]!);
    };
    return { planId, played, order, final, correction };
  }

  async function expectPublishedRoundRobinPlaces(
    planId: string,
    order: string[],
    correctedMatchId: string,
  ) {
    const state = await runtime.state(planId);
    expect(state.result!.poolOrders).toEqual([{ division: 'upper', order }]);
    const tournamentId = state.publication!.tournamentIds[0]!;
    const standings = await db
      .select()
      .from(tournamentParticipants)
      .where(eq(tournamentParticipants.tournamentId, tournamentId));
    expect(standings.map(({ playerId, finalRank }) => [playerId, finalRank]).sort()).toEqual(
      order.map((id, i) => [id, i + 1]).sort(),
    );
    const publishedSets = await db.select().from(sets).where(eq(sets.tournamentId, tournamentId));
    const corrected = publishedSets.find(
      (set) => (set.raw as { eventMatchId?: string }).eventMatchId === correctedMatchId,
    )!;
    expect(corrected).toBeDefined();
    expect(corrected.winner === 1 ? corrected.p1PlayerId : corrected.p2PlayerId).toBe(order[2]);
    expect(await runtime.replay(planId)).toEqual(state);
  }

  it('reviews a winner correction below the playoff cut and publishes the corrected places', async () => {
    const { planId, played, order, final, correction } = await playedRoundRobinPlayoff();
    const score = correction(2, 3);
    await expect(
      caller().eventOps.reportScore({ ...score, requestId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const previewInput = { planId, ...score };
    await expect(
      caller().eventOps.live.previewFinalsSlotReplay({ ...previewInput, reviewVersion: 2 }),
    ).resolves.toMatchObject({ allowed: false, qualifierChanges: [] });
    const legacy = structuredClone(played);
    delete legacy.brackets[0]!.qualifierSlots;
    expect(() => reviewPlayoffPoolScore(legacy, score)).toThrow(
      /exact recorded finals qualification sources/,
    );
    const missingSource = structuredClone(played);
    delete missingSource.matches.find(({ id }) => id === final.id)!.player1Qualifier;
    expect(() => reviewPlayoffPoolScore(missingSource, score)).toThrow(
      /exact recorded finals qualification sources/,
    );
    const manual = structuredClone(played);
    manual.pools[0]!.orderDecision!.source = 'manual';
    expect(() => reviewPlayoffPoolScore(manual, score)).toThrow(/recorded automatic pool order/);
    const preview = await caller().eventOps.live.previewFinalsSlotReplay({
      ...previewInput,
      reviewVersion: 3,
    });
    expect(preview).toMatchObject({
      allowed: true,
      qualifierChanges: [],
      poolPlacementCorrection: true,
    });
    if (!preview.allowed) throw new Error('Expected a reviewed pool correction');
    const request = {
      planId,
      requestId: crypto.randomUUID(),
      command: { ...score, kind: 'score' as const, poolGameCorrectionToken: preview.revisionToken },
    };
    await expect(
      caller().eventOps.live.command({
        ...request,
        command: { ...request.command, poolGameCorrectionToken: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await runtime.state(planId)).toEqual(played);
    const response = await caller().eventOps.live.command(request);
    expect((await caller().eventOps.live.command(request)).receipt).toEqual(response.receipt);
    const corrected = await runtime.state(planId);
    const newOrder = [order[0]!, order[1]!, order[3]!, order[2]!];
    expect(corrected.pools[0]).toMatchObject({
      order: newOrder,
      orderDecision: { source: 'automatic', order: newOrder },
    });
    expect(corrected.matches.find(({ id }) => id === final.id)).toEqual(
      played.matches.find(({ id }) => id === final.id),
    );
    expect(corrected.brackets).toEqual(played.brackets);
    expect(corrected.reports.slice(0, -1)).toEqual(played.reports);
    expect(corrected.reports.at(-1)).toMatchObject({
      matchId: score.matchId,
      winnerId: order[3],
      status: 'approved',
    });
    expect(await runtime.replay(planId)).toEqual(corrected);
    await caller().eventOps.native.finalize({ planId });
    await expectPublishedRoundRobinPlaces(planId, newOrder, score.matchId);
  });

  it('offers the winner review in the organiser overview for an original rolling playoff draw', async () => {
    const { planId, played, order, final, correction } = await playedRoundRobinPlayoff(
      false,
      async (planId) => {
        const overview = await caller().eventOps.overview({ planId });
        expect(overview.matches.some((match) => 'reviewPlayoffPoolWinner' in match)).toBe(false);
      },
    );
    const score = correction(2, 3);
    const overview = await caller().eventOps.overview({ planId });
    const source = overview.matches.find(({ id }) => id === score.matchId);
    expect(played.brackets[0]!.strengthSeeding).toBeUndefined();
    expect(source).toHaveProperty('reviewPlayoffPoolWinner', true);
    expect(source).not.toHaveProperty('reviewPoolGames');
    await caller().eventOps.settings({ planId, published: true, playerReports: true });
    const published = await caller().eventOps.snapshot({ planId });
    const publicSource = published.matches.find(({ id }) => id === score.matchId);
    expect(publicSource).toBeDefined();
    expect(publicSource).not.toHaveProperty('reviewPlayoffPoolWinner');
    expect(overview.matches.find(({ id }) => id === final.id)).not.toHaveProperty(
      'reviewPlayoffPoolWinner',
    );
    await expect(
      caller().eventOps.live.previewPoolGameCorrection({
        planId,
        matchId: score.matchId,
        expectedRevision: score.expectedRevision,
        score1: score.score2 === 2 ? 2 : 1,
        score2: score.score1 === 2 ? 2 : 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const preview = await caller().eventOps.live.previewFinalsSlotReplay({
      planId,
      ...score,
      reviewVersion: 3,
    });
    expect(preview).toMatchObject({ allowed: true, poolPlacementCorrection: true });
    if (!preview.allowed) throw new Error('Expected the reviewed correction');
    await caller().eventOps.live.command({
      planId,
      requestId: crypto.randomUUID(),
      command: { ...score, kind: 'score', poolGameCorrectionToken: preview.revisionToken },
    });
    const changed = await runtime.state(planId);
    expect(changed.matches.find(({ id }) => id === final.id)).toEqual(
      played.matches.find(({ id }) => id === final.id),
    );
    expect(changed.pools[0]!.order).toEqual([order[0], order[1], order[3], order[2]]);
    expect(await runtime.replay(planId)).toEqual(changed);
  });

  it('updates the automatic order in a sealed playoff result replacement', async () => {
    const { planId, order, final, correction } = await playedRoundRobinPlayoff();
    await caller().eventOps.native.finalize({ planId });
    const sealed = await runtime.state(planId);
    const score = correction(2, 3);
    const replace = () =>
      caller().eventOps.live.command({
        planId,
        requestId: crypto.randomUUID(),
        command: {
          kind: 'replaceResult',
          resultId: sealed.result!.id,
          reason: 'Correct the pool result',
          corrections: [score],
        },
      });
    await expect(replace()).resolves.toMatchObject({ publicationStatus: 'published' });
    const corrected = await runtime.state(planId);
    expect(corrected.result).toMatchObject({ revision: 2, replacesResultId: sealed.result!.id });
    expect(corrected.result!.matches.find(({ id }) => id === final.id)).toEqual(
      sealed.result!.matches.find(({ id }) => id === final.id),
    );
    expect(corrected.result!.brackets).toEqual(sealed.result!.brackets);
    expect(corrected.reports).toEqual(sealed.reports);
    await expectPublishedRoundRobinPlaces(
      planId,
      [order[0]!, order[1]!, order[3]!, order[2]!],
      score.matchId,
    );
  });

  it.each([
    { name: 'tied order', higher: 0, lower: 3, replayAllowed: false, message: /separate ruling/ },
    {
      name: 'changed qualifiers',
      higher: 1,
      lower: 2,
      replayAllowed: true,
      message: /finals qualification/,
    },
  ])(
    'keeps the result fixed when a correction would produce $name',
    async ({ higher, lower, replayAllowed, message }) => {
      const { planId, played, correction } = await playedRoundRobinPlayoff();
      const score = correction(higher, lower);
      const preview = await caller().eventOps.live.previewFinalsSlotReplay({
        planId,
        ...score,
        reviewVersion: 3,
      });
      expect(preview).not.toHaveProperty('poolPlacementCorrection');
      expect(preview.allowed).toBe(replayAllowed);
      expect(preview.qualifierChanges).toHaveLength(replayAllowed ? 1 : 0);
      // A cut change can still use the explicitly reviewed finals replay.
      await expect(
        caller().eventOps.live.command({
          planId,
          requestId: crypto.randomUUID(),
          command: {
            ...score,
            kind: 'score',
            poolGameCorrectionToken: preview.allowed ? preview.revisionToken : '0'.repeat(64),
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(message) });
      expect(await runtime.state(planId)).toEqual(played);
      await caller().eventOps.native.finalize({ planId });
      const sealed = await runtime.state(planId);
      await expect(
        caller().eventOps.live.command({
          planId,
          requestId: crypto.randomUUID(),
          command: {
            kind: 'replaceResult',
            resultId: sealed.result!.id,
            reason: 'Correct the pool result',
            corrections: [score],
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(message) });
      expect(await runtime.state(planId)).toEqual(sealed);
      expect(await runtime.replay(planId)).toEqual(sealed);
    },
  );
});
