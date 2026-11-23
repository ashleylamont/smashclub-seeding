import { expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eventPlans, nativeLiveHandoffs, user } from '@smashclub/db';
import { eq } from 'drizzle-orm';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createNativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

it('scopes the presentation setting to a published linked event and its organisers', async () => {
  const { db, close } = await createTestDb();
  try {
    const context = {
      db,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    };
    const organiser = {
      id: 'broadcast-organiser',
      email: 'broadcast-organiser@example.test',
      name: 'Broadcast organiser',
      role: 'user' as const,
    };
    await db.insert(user).values(organiser);
    const admin = appRouter.createCaller({ ...context, user: nativeAdmin });
    const desk = appRouter.createCaller({ ...context, user: organiser }).eventOps;
    const viewer = appRouter.createCaller({ ...context, user: null }).eventOps;
    const ids = await db
      .insert(eventPlans)
      .values(
        ['Linked event', 'Other event'].map((name) => ({
          name,
          eventDate: new Date(),
          bracketMode: 'challonge' as const,
          status: 'underway' as const,
        })),
      )
      .returning({ id: eventPlans.id });
    const [{ id: planId }, { id: otherId }] = ids as [{ id: string }, { id: string }];
    const update = { planId, expectedRevision: 0, mode: 'progress' as const };
    const settings = { planId, published: true, playerReports: false };
    await expect(viewer.setBroadcastPresentation(update)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(desk.setBroadcastPresentation(update)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await admin.eventOps.assignTo({ planId, userId: organiser.id });
    await expect(desk.setBroadcastPresentation(update)).rejects.toMatchObject({ code: 'CONFLICT' });
    await admin.eventOps.settings(settings);
    await admin.eventOps.settings({ ...settings, planId: otherId });
    await expect(
      desk.setBroadcastPresentation({ ...update, planId: otherId }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await desk.overview({ planId })).broadcastPresentation).toEqual({
      mode: 'auto',
      revision: 0,
    });
    expect(await viewer.snapshot({ planId })).not.toHaveProperty('broadcastPresentationMode');

    await expect(desk.setBroadcastPresentation(update)).resolves.toEqual({
      mode: 'progress',
      revision: 1,
    });
    await expect(desk.setBroadcastPresentation(update)).resolves.toEqual({
      mode: 'progress',
      revision: 1,
    });
    const snapshot = await viewer.snapshot({ planId });
    expect(snapshot.broadcastPresentationMode).toBe('progress');
    expect(snapshot).not.toHaveProperty('broadcastPresentation');
    expect(await viewer.snapshot({ planId: otherId })).not.toHaveProperty(
      'broadcastPresentationMode',
    );
    await expect(
      desk.setBroadcastPresentation({ ...update, mode: 'gameplay' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      desk.setBroadcastPresentation({ ...update, mode: 'gameplay', expectedRevision: 1 }),
    ).resolves.toEqual({ mode: 'gameplay', revision: 2 });
    await expect(desk.setBroadcastPresentation(update)).rejects.toMatchObject({ code: 'CONFLICT' });

    await admin.eventOps.settings({ ...settings, published: false });
    await expect(viewer.snapshot({ planId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      desk.setBroadcastPresentation({ ...update, mode: 'auto', expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await desk.overview({ planId })).broadcastPresentation).toEqual({
      mode: 'gameplay',
      revision: 2,
    });
    await admin.eventOps.settings(settings);
    await admin.admin.eventPlanner.closePlan({ planId, status: 'complete' });
    expect(await viewer.snapshot({ planId })).not.toHaveProperty('broadcastPresentationMode');
    await expect(
      desk.setBroadcastPresentation({ ...update, mode: 'auto', expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await close();
  }
});

it('updates a native event independently of the journal and public lifecycle', async () => {
  const { db, close } = await createTestDb();
  const runtime = createNativeRuntime(db, new InMemoryStore());
  try {
    const context = {
      db,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    };
    const admin = appRouter.createCaller({ ...context, user: nativeAdmin });
    const viewer = appRouter.createCaller({ ...context, user: null }).eventOps;
    const planId = await seedNativeDraft(db);
    const request = { planId, expectedRevision: 0, mode: 'gameplay' as const };
    await expect(admin.eventOps.setBroadcastPresentation(request)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(
      await db.select().from(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toHaveLength(0);
    await admin.eventOps.settings({ planId, published: true, playerReports: true });
    await admin.eventOps.softLockPools({ planId, confirm: true });
    const before = await runtime.replay(planId);

    await expect(admin.eventOps.setBroadcastPresentation(request)).resolves.toEqual({
      mode: 'gameplay',
      revision: 1,
    });
    const publicMode = await viewer.snapshot({ planId });
    expect(publicMode.broadcastPresentationMode).toBe('gameplay');
    expect(publicMode).not.toHaveProperty('broadcastPresentation');
    expect((await admin.eventOps.overview({ planId })).broadcastPresentation).toEqual({
      mode: 'gameplay',
      revision: 1,
    });
    expect(await runtime.replay(planId)).toEqual(before);

    await admin.admin.eventPlanner.closePlan({ planId, status: 'cancelled' });
    expect(await viewer.snapshot({ planId })).not.toHaveProperty('broadcastPresentationMode');
    await expect(admin.eventOps.setBroadcastPresentation(request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  } finally {
    await runtime.shutdown();
    await close();
  }
});
