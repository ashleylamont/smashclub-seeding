import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventPlans, eventTwitchPromotions, user } from '@smashclub/db';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createPostgresNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { contend, postgresCluster } from './helpers/postgres';

type Cluster = Awaited<ReturnType<typeof postgresCluster>>;

function caller(
  cluster: Cluster,
  account: typeof nativeAdmin | null,
  nativeRuntime?: NativeRuntime,
) {
  return appRouter.createCaller({
    db: cluster.db,
    user: account,
    nativeRuntime,
    env: loadEnv({ DATABASE_URL: cluster.connectionString, NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(cluster.db),
  });
}

function promotion(channel: string) {
  return { channel, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
}

it('serializes linked announcements with event settings and rejects stale replays after Stop', async () => {
  const cluster = await postgresCluster();
  const admin = caller(cluster, nativeAdmin);
  const viewer = caller(cluster, null).eventOps;
  try {
    const organiser = {
      id: 'stream-to',
      email: 'stream-to@example.test',
      name: 'Stream TO',
      role: 'user' as const,
    };
    const outsider = { ...organiser, id: 'stream-viewer', email: 'stream-viewer@example.test' };
    await cluster.db.insert(user).values([organiser, outsider]);
    const [linked, other] = await cluster.db
      .insert(eventPlans)
      .values([
        { name: 'Linked Stream Night', eventDate: new Date(), status: 'underway' },
        { name: 'Other Event', eventDate: new Date(), status: 'underway' },
      ])
      .returning();
    const planId = linked!.id;
    const control = caller(cluster, organiser).eventOps;
    const start = { planId, expectedRevision: 0, promotion: promotion('first_channel') };
    await expect(viewer.setTwitchPromotion(start)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller(cluster, outsider).eventOps.setTwitchPromotion(start),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.eventOps.assignTo({ planId, userId: organiser.id });
    await expect(control.setTwitchPromotion(start)).rejects.toMatchObject({ code: 'CONFLICT' });
    const publish = { planId, published: true, playerReports: false };
    await admin.eventOps.settings(publish);
    await admin.eventOps.settings({ ...publish, planId: other!.id });
    await expect(
      control.setTwitchPromotion({
        ...start,
        promotion: { ...start.promotion, channel: 'https://twitch.tv.example.test/first_channel' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const results = await contend(cluster, planId, [
      () =>
        control.setTwitchPromotion({
          ...start,
          promotion: { ...start.promotion, channel: 'https://www.twitch.tv/First_Channel' },
        }),
      () => control.setTwitchPromotion({ ...start, promotion: promotion('other_channel') }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = results.find((result) => result.status === 'fulfilled')!.value;
    expect(winner.revision).toBe(1);
    expect(winner.promotion?.channel).toMatch(/^(first_channel|other_channel)$/);
    const applied = { ...start, promotion: winner.promotion };
    await expect(control.setTwitchPromotion(applied)).resolves.toEqual(winner);
    expect(await viewer.resolvePublicCode({ code: String(linked!.publicCode) })).toEqual({
      planId,
    });
    const snapshot = await viewer.snapshot({ planId });
    expect(snapshot.twitchPromotion).toEqual(winner.promotion);
    expect(snapshot).not.toHaveProperty('twitchBroadcast');
    expect(snapshot.plan).not.toHaveProperty('twitchRevision');
    const discovery = await viewer.publicEvents();
    expect(discovery.find((event) => event.id === planId)).toHaveProperty(
      'twitchPromotion',
      winner.promotion,
    );
    expect(discovery.find((event) => event.id === other!.id)).not.toHaveProperty('twitchPromotion');

    const [racingStart, unpublish] = await contend<unknown>(cluster, other!.id, [
      () => admin.eventOps.setTwitchPromotion({ ...start, planId: other!.id }),
      () => admin.eventOps.settings({ ...publish, planId: other!.id, published: false }),
    ]);
    expect(unpublish?.status).toBe('fulfilled');
    expect(racingStart?.status === 'fulfilled' || racingStart?.reason?.code === 'CONFLICT').toBe(
      true,
    );
    await expect(viewer.snapshot({ planId: other!.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await admin.eventOps.settings({ ...publish, published: false });
    await expect(viewer.snapshot({ planId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await viewer.publicEvents()).some((event) => event.id === planId)).toBe(false);
    expect((await control.overview({ planId })).twitchBroadcast).toEqual(winner);
    const stop = { planId, expectedRevision: 1, promotion: null };
    await expect(control.setTwitchPromotion(stop)).resolves.toEqual({
      promotion: null,
      revision: 2,
    });
    await expect(control.setTwitchPromotion(stop)).resolves.toEqual({
      promotion: null,
      revision: 2,
    });
    await admin.eventOps.settings(publish);
    await expect(control.setTwitchPromotion(applied)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await viewer.snapshot({ planId })).not.toHaveProperty('twitchPromotion');

    const bad = {
      planId,
      expectedRevision: 2,
      promotion: {
        channel: 'future',
        expiresAt: new Date(Date.now() + 9 * 60 * 60_000).toISOString(),
      },
    };
    await expect(control.setTwitchPromotion(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      control.setTwitchPromotion({
        ...bad,
        promotion: { ...bad.promotion, expiresAt: new Date(Date.now() - 1_000).toISOString() },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await control.setTwitchPromotion({ ...bad, promotion: promotion('last_channel') });
    await admin.admin.eventPlanner.closePlan({ planId, status: 'complete' });
    expect(await viewer.snapshot({ planId })).not.toHaveProperty('twitchPromotion');
    await expect(
      control.setTwitchPromotion({
        ...bad,
        expectedRevision: 3,
        promotion: promotion('after_close'),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const [saved] = await cluster.db
      .select()
      .from(eventTwitchPromotions)
      .where(eq(eventTwitchPromotions.eventPlanId, planId));
    expect(saved).toMatchObject({ revision: 3, channel: 'last_channel' });
    await expect(
      cluster.pool.query(
        'update event_twitch_promotions set expires_at = null where event_plan_id = $1',
        [planId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await cluster.db.delete(eventPlans).where(eq(eventPlans.id, planId));
    expect(
      await cluster.db
        .select()
        .from(eventTwitchPromotions)
        .where(eq(eventTwitchPromotions.eventPlanId, planId)),
    ).toHaveLength(0);
  } finally {
    await cluster.close();
  }
});

it('hides a native write racing unpublish, then resumes the bounded announcement after restart and explicit republish', async () => {
  const cluster = await postgresCluster();
  let runtime = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
  try {
    const planId = await seedNativeDraft(cluster.db);
    await cluster.db
      .update(eventPlans)
      .set({ status: 'underway' })
      .where(eq(eventPlans.id, planId));
    const input = { planId, expectedRevision: 0, promotion: promotion('native_channel') };
    const admin = caller(cluster, nativeAdmin, runtime);
    await expect(admin.eventOps.setTwitchPromotion(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    // Normal workspace entry performs the supported lazy transfer.
    await admin.eventOps.overview({ planId });
    const before = await runtime.replay(planId);
    await expect(
      cluster.pool.query('update event_plans set name = $2 where id = $1', [
        planId,
        'Blocked overwrite',
      ]),
    ).rejects.toMatchObject({ code: 'P0001' });

    let captured!: () => void;
    let release!: () => void;
    const capturedState = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const canSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racingRuntime: NativeRuntime = {
      ...runtime,
      async state(id) {
        const state = await runtime.state(id);
        captured();
        await canSave;
        return state;
      },
    };
    const saving = caller(cluster, nativeAdmin, racingRuntime).eventOps.setTwitchPromotion(input);
    try {
      await capturedState;
      await admin.eventOps.settings({ planId, published: false, playerReports: false });
    } finally {
      release();
    }
    await expect(saving).resolves.toEqual({ promotion: input.promotion, revision: 1 });
    const after = await runtime.replay(planId);
    expect(after).toMatchObject({ sequence: before.sequence + 1, settings: { published: false } });
    const viewer = caller(cluster, null, runtime).eventOps;
    await expect(viewer.snapshot({ planId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await viewer.publicEvents()).some((event) => event.id === planId)).toBe(false);
    const withoutRuntime = caller(cluster, null).eventOps;
    expect(
      (await withoutRuntime.publicEvents()).find((event) => event.id === planId),
    ).not.toHaveProperty('twitchPromotion');

    await runtime.shutdown();
    runtime = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
    const restarted = caller(cluster, nativeAdmin, runtime);
    expect((await restarted.eventOps.overview({ planId })).twitchBroadcast).toEqual({
      promotion: input.promotion,
      revision: 1,
    });
    await restarted.eventOps.settings({ planId, published: true, playerReports: false });
    const freshViewer = caller(cluster, null, runtime).eventOps;
    expect((await freshViewer.snapshot({ planId })).twitchPromotion).toEqual(input.promotion);
    expect((await freshViewer.publicEvents()).find((event) => event.id === planId)).toHaveProperty(
      'twitchPromotion',
      input.promotion,
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(input.promotion.expiresAt));
    try {
      expect(await freshViewer.snapshot({ planId })).not.toHaveProperty('twitchPromotion');
      expect(
        (await freshViewer.publicEvents()).find((event) => event.id === planId),
      ).not.toHaveProperty('twitchPromotion');
      await expect(restarted.eventOps.setTwitchPromotion(input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    } finally {
      clock.mockRestore();
    }
    const renewed = { ...input, expectedRevision: 1, promotion: promotion('renewed_channel') };
    await restarted.eventOps.setTwitchPromotion(renewed);
    await restarted.admin.eventPlanner.closePlan({ planId, status: 'cancelled' });
    expect(await freshViewer.snapshot({ planId })).not.toHaveProperty('twitchPromotion');
    expect(
      (await freshViewer.publicEvents()).find((event) => event.id === planId),
    ).not.toHaveProperty('twitchPromotion');
    await expect(
      restarted.eventOps.setTwitchPromotion({ ...renewed, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const { token } = await restarted.admin.eventPlanner.recoveryPreview({ planId });
    const reset = await restarted.admin.eventPlanner.recoverPlan({
      planId,
      operation: 'reset',
      token,
      requestId: 'twitch-replacement-plan',
      reason: 'Rehearse reset without carrying the stream announcement',
      withdrawResults: false,
    });
    expect(reset.replacementPlanId).toBeTruthy();
    expect(
      (await restarted.eventOps.overview({ planId: reset.replacementPlanId! })).twitchBroadcast,
    ).toEqual({ promotion: null, revision: 0 });
    await expect(freshViewer.snapshot({ planId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await runtime.shutdown();
    await cluster.close();
  }
});
