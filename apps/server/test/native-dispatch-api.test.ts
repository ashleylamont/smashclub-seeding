import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import type { Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';

describe('shared dispatch through the application API', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });
  function caller(user: SessionUser | null = nativeAdmin) {
    return appRouter.createCaller({
      db,
      nativeRuntime: runtime,
      user,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  }
  async function night() {
    const planId = await seedNativeDraft(db);
    const api = caller();
    await api.eventOps.softLockPools({ planId, confirm: true });
    await api.eventOps.live.command({
      planId,
      requestId: crypto.randomUUID(),
      command: {
        kind: 'configureDispatch',
        capacity: 2,
        reservedStationIds: [],
        expectedResourceRevision: 0,
      },
    });
    return { planId, api };
  }

  it('keeps queue order and private snooze details out of every public snapshot', async () => {
    const { planId, api } = await night();
    const desk = await api.eventOps.live.dispatchDesk({ planId });
    const target = desk.queue[1]!;
    await api.eventOps.live.command({
      planId,
      requestId: 'reorder',
      command: {
        kind: 'queueMove',
        matchId: target.matchId,
        beforeMatchId: desk.queue[0]!.matchId,
        expectedQueueRevision: 0,
      },
    });
    const entrant = desk.entrants[0]!;
    await api.eventOps.live.command({
      planId,
      requestId: 'snooze',
      command: {
        kind: 'availability',
        playerId: entrant.id,
        expectedRevision: entrant.revision,
        availability: 'snoozed',
        reason: 'Private TO note: away on a call',
      },
    });
    const overview = await api.eventOps.overview({ planId });
    expect(overview.operatorDispatch!.queue[0]!.matchId).toBe(target.matchId);
    expect(overview.operatorDispatch!.entrants[0]!.availability).toBe('snoozed');
    expect(
      overview.operatorDispatch!.entrants.every(
        (entrant) =>
          entrant.name === overview.entrants.find((player) => player.id === entrant.id)?.name,
      ),
    ).toBe(true);
    expect(
      desk.entrants.every(
        (entrant) =>
          entrant.name === overview.entrants.find((player) => player.id === entrant.id)?.name,
      ),
    ).toBe(true);

    const publicBoard = await caller(null).eventOps.snapshot({ planId });
    expect(publicBoard).not.toHaveProperty('operatorDispatch');
    expect(publicBoard.stationQueues).toEqual([]);
    expect(publicBoard.settings).not.toHaveProperty('queueOrder');
    expect(JSON.stringify(publicBoard)).not.toContain('Private TO note');
    expect(
      publicBoard.matches
        .filter((m) => m.status === 'ready')
        .every((m) => m.availability.reasons.every((r) => r.code === 'awaiting_call')),
    ).toBe(true);
    const direct = await caller(null).eventOps.live.snapshot({ planId });
    expect(direct.settings).not.toHaveProperty('queueOrder');
    expect(direct.audit).toEqual([]);
    expect(JSON.stringify(direct)).not.toContain('Private TO note');
    await expect(caller(null).eventOps.live.dispatchDesk({ planId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller({
        ...nativeAdmin,
        id: 'unassigned-player',
        role: 'user',
      }).eventOps.live.dispatchDesk({ planId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('publishes only actual calls, releases an untaken call, and retains receipt/replay semantics', async () => {
    const { planId, api } = await night();
    const before = await api.eventOps.overview({ planId });
    const match = before.matches.find((m) => m.status === 'ready')!;
    const request = {
      planId,
      requestId: 'call-at-window',
      command: {
        kind: 'dispatch' as const,
        matchId: match.id,
        expectedRevision: match.revision,
        stationId: null,
        expectedResourceRevision: before.settings.resourceRevision,
        callOnly: true,
        callLocation: 'Window',
      },
    };
    await api.eventOps.live.command(request);
    await api.eventOps.live.command(request);
    const unrelated = before.matches.find((m) => m.division !== match.division)!;
    await api.eventOps.reportScore({
      matchId: unrelated.id,
      expectedRevision: unrelated.revision,
      requestId: 'unrelated-during-call',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    const board = await caller(null).eventOps.snapshot({ planId });
    expect(board.matches.find((m) => m.id === match.id)).toMatchObject({
      status: 'playing',
      started: false,
      called: true,
      callLocation: 'Window',
      stationId: null,
    });
    expect(board.sharedDispatch).toMatchObject({ active: 1, capacity: 2 });
    expect(
      (await api.eventOps.live.overview({ planId })).audit.filter((a) => a.kind === 'dispatch'),
    ).toHaveLength(1);
    const playing = await api.eventOps.overview({ planId });
    await api.eventOps.updateMatch({
      matchId: match.id,
      expectedRevision: match.revision,
      expectedResourceRevision: playing.settings.resourceRevision,
      status: 'ready',
      stationId: null,
    });
    expect((await caller(null).eventOps.snapshot({ planId })).sharedDispatch!.active).toBe(0);
    const state = await runtime.state(planId);
    expect(state.matches.find((m) => m.id === match.id)).toMatchObject({
      started: false,
      calledAt: null,
      callLocation: null,
    });
    expect(await runtime.replay(planId)).toEqual(state);
  });

  it('keeps operator holds through unrelated scores and resumes pools independently', async () => {
    const { planId, api } = await night();
    const before = await api.eventOps.overview({ planId });
    const match = before.matches[0]!;
    await api.eventOps.updateMatch({
      matchId: match.id,
      status: 'blocked',
      blockedReason: 'Hold for a TO ruling',
      stationId: null,
      expectedRevision: match.revision,
      expectedResourceRevision: before.settings.resourceRevision,
    });
    const other = before.matches.find((m) => m.division !== match.division)!;
    await api.eventOps.reportScore({
      matchId: other.id,
      expectedRevision: other.revision,
      requestId: 'unrelated-score',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    expect(
      (await api.eventOps.overview({ planId })).matches.find((m) => m.id === match.id)!.status,
    ).toBe('blocked');
    const desk = await api.eventOps.live.dispatchDesk({ planId });
    const pool = desk.pools.find((p) => p.division !== match.division)!;
    await api.eventOps.live.command({
      planId,
      requestId: 'hold-one-pool',
      command: {
        kind: 'poolResources',
        poolId: pool.id,
        stationIds: [],
        active: false,
        selfRun: pool.selfRun,
        autoAcceptScores: pool.autoAcceptScores,
        expectedResourceRevision: desk.resourceRevision,
      },
    });
    const held = await api.eventOps.live.dispatchDesk({ planId });
    expect(held.queue.some((r) => r.reasons.some((reason) => reason.code === 'pool_held'))).toBe(
      true,
    );
    expect(held.queue.some((r) => r.canDispatchOrdinary)).toBe(true);
  });
});
