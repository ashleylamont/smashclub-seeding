import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventPlans } from '@smashclub/db';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createPostgresNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { contend, postgresCluster } from './helpers/postgres';

it('serializes competing native presentation writes and keeps the winner across restarts', async () => {
  const cluster = await postgresCluster();
  const { db, connectionString } = cluster;
  let runtime = await createPostgresNativeRuntime(db, connectionString);
  try {
    const planId = await seedNativeDraft(db);
    const caller = (user: typeof nativeAdmin | null, nativeRuntime: NativeRuntime = runtime) =>
      appRouter.createCaller({
        db,
        user,
        nativeRuntime,
        env: loadEnv({ DATABASE_URL: connectionString, NODE_ENV: 'test' }),
        challonge: new ChallongeClient({}),
        recomputeTrigger: new RecomputeTrigger(db),
      });
    await db.update(eventPlans).set({ status: 'underway' }).where(eq(eventPlans.id, planId));
    const { eventOps: desk } = caller(nativeAdmin);
    await desk.overview({ planId });
    const before = await runtime.replay(planId);
    const request = { planId, expectedRevision: 0 };

    const writes = await contend(cluster, planId, [
      () => desk.setBroadcastPresentation({ ...request, mode: 'gameplay' }),
      () => desk.setBroadcastPresentation({ ...request, mode: 'progress' }),
    ]);
    const winner = writes.find((result) => result.status === 'fulfilled')?.value;
    expect(winner).toMatchObject({ revision: 1 });
    expect(writes.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      code: 'CONFLICT',
    });
    expect(await runtime.replay(planId)).toEqual(before);

    await runtime.shutdown();
    runtime = await createPostgresNativeRuntime(db, connectionString);
    expect((await caller(nativeAdmin).eventOps.overview({ planId })).broadcastPresentation).toEqual(
      winner,
    );
    const viewer = caller(null).eventOps;
    expect((await viewer.snapshot({ planId })).broadcastPresentationMode).toBe(winner?.mode);

    let observed!: () => void;
    let resume!: () => void;
    const observation = new Promise<void>((resolve) => (observed = resolve));
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const racingRuntime: NativeRuntime = {
      ...runtime,
      async state(id) {
        const state = await runtime.state(id);
        observed();
        await paused;
        return state;
      },
    };
    const racingWrite = caller(nativeAdmin, racingRuntime).eventOps.setBroadcastPresentation({
      planId,
      expectedRevision: 1,
      mode: 'auto',
    });
    const settings = { planId, published: false, playerReports: false };
    try {
      await Promise.race([observation, racingWrite]);
      await caller(nativeAdmin).eventOps.settings(settings);
    } finally {
      resume();
    }
    await expect(racingWrite).resolves.toEqual({ mode: 'auto', revision: 2 });
    await expect(viewer.snapshot({ planId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller(nativeAdmin).eventOps.setBroadcastPresentation({
        planId,
        expectedRevision: 1,
        mode: 'auto',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await runtime.shutdown();
    await cluster.close();
  }
});
