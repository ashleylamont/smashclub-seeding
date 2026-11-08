import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { InMemoryStore } from '@rotorsoft/act';
import { eventOperationSettings, eventPlans, nativeLiveHandoffs } from '@smashclub/db';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createNativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

it('resolves short codes through the same SQL and Act publication checks as UUID links', async () => {
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
    const publicOps = appRouter.createCaller({ ...context, user: null }).eventOps;
    const adminOps = appRouter.createCaller({ ...context, user: nativeAdmin }).eventOps;
    const [legacy] = await db
      .insert(eventPlans)
      .values({ name: 'Private linked event', eventDate: new Date(), bracketMode: 'challonge' })
      .returning({ id: eventPlans.id, code: eventPlans.publicCode });
    const legacyCode = String(legacy!.code);
    const missing = { code: 'NOT_FOUND', message: 'Event not found.' };
    await expect(publicOps.resolvePublicCode({ code: '99999999' })).rejects.toMatchObject(missing);
    await expect(publicOps.resolvePublicCode({ code: legacyCode })).rejects.toMatchObject(missing);
    await expect(publicOps.resolvePublicCode({ code: '123' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await db.update(eventPlans).set({ status: 'underway' }).where(eq(eventPlans.id, legacy!.id));
    await adminOps.settings({ planId: legacy!.id, published: true, playerReports: false });
    expect(await publicOps.resolvePublicCode({ code: legacyCode })).toEqual({ planId: legacy!.id });
    expect(await publicOps.snapshot({ planId: legacy!.id })).toMatchObject({
      publicCode: legacy!.code,
      plan: { id: legacy!.id, liveOwned: false },
    });
    await db.update(eventPlans).set({ deletedAt: new Date() }).where(eq(eventPlans.id, legacy!.id));
    await expect(publicOps.resolvePublicCode({ code: legacyCode })).rejects.toMatchObject(missing);

    const planId = await seedNativeDraft(db);
    const [unowned] = await db
      .update(eventPlans)
      .set({ softLockedAt: new Date() })
      .where(eq(eventPlans.id, planId))
      .returning({ code: eventPlans.publicCode });
    await db
      .update(eventOperationSettings)
      .set({ published: false })
      .where(eq(eventOperationSettings.eventPlanId, planId));
    const unownedCode = String(unowned!.code);
    await expect(publicOps.resolvePublicCode({ code: unownedCode })).rejects.toMatchObject(missing);
    expect(
      await db.select().from(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toHaveLength(0);
    await db.update(eventPlans).set({ softLockedAt: null }).where(eq(eventPlans.id, planId));
    await adminOps.settings({ planId, published: true, playerReports: false });
    await adminOps.softLockPools({ planId, confirm: true });
    const active = await publicOps.snapshot({ planId });
    expect(active.publicCode).toBe(unowned!.code);
    expect(active.plan.liveOwned).toBe(true);
    expect(String(active.publicCode)).toMatch(/^[1-9]\d{6,7}$/);
    expect(active.publicCode).not.toBe(legacy!.code);
    const nativeCode = String(active.publicCode);
    expect(await publicOps.resolvePublicCode({ code: nativeCode })).toEqual({ planId });
    await adminOps.settings({ planId, published: false, playerReports: false });
    const [sqlSettings] = await db
      .select({ published: eventOperationSettings.published })
      .from(eventOperationSettings)
      .where(eq(eventOperationSettings.eventPlanId, planId));
    expect(sqlSettings?.published).toBe(true);
    await expect(publicOps.resolvePublicCode({ code: nativeCode })).rejects.toMatchObject(missing);
    await expect(publicOps.snapshot({ planId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await adminOps.settings({ planId, published: true, playerReports: false });
    expect(await publicOps.resolvePublicCode({ code: nativeCode })).toEqual({ planId });
  } finally {
    await runtime.shutdown();
    await close();
  }
});
