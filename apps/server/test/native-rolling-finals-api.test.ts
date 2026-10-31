import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import type { Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import type { TournamentState } from '../src/tournament/schemas';

describe('rolling finals through the standard native API', () => {
  let db: Db, close: () => Promise<void>, live: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    live = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await live.shutdown();
    await close();
  });
  function caller(actor: typeof nativeAdmin | null = nativeAdmin) {
    return appRouter.createCaller({
      db,
      nativeRuntime: live,
      user: actor,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  }
  async function scorePool(planId: string, poolId: string) {
    const state = await live.state(planId);
    const pool = state.pools.find((p) => p.id === poolId)!;
    for (const m of state.matches.filter((m) => m.poolId === poolId)) {
      const first = pool.entrantIds.indexOf(m.player1Id!) < pool.entrantIds.indexOf(m.player2Id!);
      await caller().eventOps.reportScore({
        matchId: m.id,
        expectedRevision: m.revision,
        requestId: m.id,
        score1: first ? 2 : 0,
        score2: first ? 0 : 2,
        outcome: 'played',
      });
    }
  }
  const command = (planId: string, input: Parameters<NativeRuntime['command']>[3]) =>
    live.command(nativeAdmin, planId, crypto.randomUUID(), input);
  function upperFinal(state: TournamentState) {
    return state.matches.find(
      (m) => m.bracketId && m.division === 'upper' && m.status === 'ready',
    )!;
  }

  it('creates a full field with held unresolved pools, releases known finals into shared capacity, and keeps publication separate', async () => {
    const planId = await seedNativeDraft(db);
    await caller().eventOps.softLockPools({ planId, confirm: true });
    let state = await live.state(planId);
    const held = state.pools.find((p) => p.division === 'lower')!;
    await command(planId, {
      kind: 'poolResources',
      poolId: held.id,
      active: false,
      stationIds: [],
      selfRun: false,
      autoAcceptScores: false,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    state = await live.state(planId);
    await command(planId, {
      kind: 'configureDispatch',
      capacity: 2,
      reservedStationIds: [],
      expectedResourceRevision: state.settings.resourceRevision,
    });
    const before = await live.state(planId);
    const early = await caller().eventOps.native.preview({ planId });
    expect(early.allowed).toBe(true);
    expect('rolling' in early && early.rolling).toBe(true);
    expect(early.brackets).toHaveLength(4);
    expect(await live.state(planId)).toEqual(before);
    // A reviewed preview cannot be reused after its result evidence changes.
    const firstPool = before.pools[0]!;
    await scorePool(planId, firstPool.id);
    await expect(
      caller().eventOps.native.generate({ planId, revisionToken: early.revisionToken }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const preview = await caller().eventOps.native.preview({ planId });
    await caller().eventOps.native.generate({ planId, revisionToken: preview.revisionToken });
    for (const pool of (await live.state(planId)).pools.filter(
      (p) => p.division === 'upper' && p.id !== firstPool.id,
    ))
      await scorePool(planId, pool.id);
    state = await live.state(planId);
    const ready = upperFinal(state);
    expect(ready).toBeDefined();
    expect(state.pools.find((p) => p.id === held.id)!.active).toBe(false);
    const operator = await caller().eventOps.overview({ planId });
    expect(operator.matches.find((m) => m.id === ready.id)!.availability.canStart).toBe(true);
    expect(
      operator.matches.some(
        (m) =>
          m.nativeBracketId && m.player1Qualifier?.status === 'pending' && m.player1Id === null,
      ),
    ).toBe(true);
    await command(planId, {
      kind: 'dispatch',
      matchId: ready.id,
      stationId: null,
      callOnly: true,
      expectedRevision: ready.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    const snapshot = await caller(null).eventOps.snapshot({ planId });
    expect(snapshot.matches.find((m) => m.id === ready.id)).toMatchObject({
      status: 'playing',
      called: true,
      stationId: null,
    });
    expect(
      snapshot.nativeBrackets.some((b) => b.qualifierSlots?.some((q) => q.status === 'pending')),
    ).toBe(true);
    expect(state.result).toBeNull();
    expect(state.publication).toBeNull();
    const existing = await caller().eventOps.native.preview({ planId });
    expect(existing.allowed).toBe(false);
    expect(existing.resetAllowed).toBe(false);
    expect(existing.resetIssues.join(' ')).toContain('untaken');
    await expect(
      caller().eventOps.native.generate({ planId, revisionToken: existing.revisionToken }),
    ).rejects.toThrow(/already exist/);
    expect(await live.replay(planId)).toEqual(await live.state(planId));
  });

  it('lets the planner rule on an unrelated tied pool after actual finals play and rejects corrections to consumed pool evidence', async () => {
    const planId = await seedNativeDraft(db);
    await caller().eventOps.softLockPools({ planId, confirm: true });
    const preview = await caller().eventOps.native.preview({ planId });
    await caller().eventOps.native.generate({ planId, revisionToken: preview.revisionToken });
    let state = await live.state(planId);
    for (const pool of state.pools.filter((p) => p.division === 'upper'))
      await scorePool(planId, pool.id);
    state = await live.state(planId);
    const ready = upperFinal(state);
    await caller().eventOps.reportScore({
      matchId: ready.id,
      expectedRevision: ready.revision,
      requestId: 'played-upper-final',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    const actual = (await live.state(planId)).matches.find((m) => m.id === ready.id)!;
    const lower = state.pools.filter((p) => p.division === 'lower');
    for (const pool of lower) await scorePool(planId, pool.id);
    state = await live.state(planId);
    const tied = lower[0]!;
    const reversed = state.matches.find(
      (m) =>
        m.poolId === tied.id &&
        [m.player1Id, m.player2Id].includes(tied.entrantIds[0]!) &&
        [m.player1Id, m.player2Id].includes(tied.entrantIds[2]!),
    )!;
    const winner = reversed.player1Id === tied.entrantIds[2];
    await caller().eventOps.reportScore({
      matchId: reversed.id,
      expectedRevision: reversed.revision,
      requestId: 'create-lower-tie',
      score1: winner ? 2 : 0,
      score2: winner ? 0 : 2,
      outcome: 'played',
    });
    const plan = (await caller().admin.eventPlanner.plan({ planId }))!;
    const pool = plan.divisions
      .find((d) => d.division === 'lower')!
      .pools.find((p) => p.poolIndex === tied.index)!;
    expect(pool.orderStatus!.status).toBe('ruling_required');
    expect(pool.orderLockedReason).toBeUndefined();
    await caller().admin.eventPlanner.savePoolPlacements({
      planId,
      division: 'lower',
      pools: [
        {
          poolIndex: pool.poolIndex,
          playerIdsInOrder: pool.members.map((m) => m.playerId),
          expectedPlacementRevision: pool.placementRevision,
          expectedMatchRevisions: pool.matchRevisions,
        },
      ],
    });
    state = await live.state(planId);
    expect(state.matches.find((m) => m.id === ready.id)).toEqual(actual);
    expect(
      state.matches.some((m) => m.bracketId && m.division === 'lower' && m.status === 'ready'),
    ).toBe(true);
    const consumed = state.matches.find((m) => m.poolId === actual.player1Qualifier!.poolId)!;
    await expect(
      caller().eventOps.reportScore({
        matchId: consumed.id,
        expectedRevision: consumed.revision,
        requestId: 'blocked-pool-rewrite',
        score1: 0,
        score2: 2,
        outcome: 'played',
      }),
    ).rejects.toThrow(/Finals already use/);
    const profile = { ...nativeAdmin, id: 'rolling-dispute-attendee', role: 'user' as const };
    const report = await caller(profile).eventOps.reportScore({
      matchId: consumed.id,
      expectedRevision: consumed.revision,
      requestId: 'accepted-consumed-dispute',
      score1: 0,
      score2: 2,
      outcome: 'played',
    });
    expect(report.status).toBe('pending');
    expect((await live.state(planId)).matches.find((m) => m.id === actual.id)!.winnerId).toBe(
      actual.winnerId,
    );
    await caller().eventOps.reviewReport({ reportId: report.id, approve: false });
    expect(
      (await live.state(planId)).pools.find((p) => p.id === actual.player1Qualifier!.poolId)!.order,
    ).toBeTruthy();
  });
});
