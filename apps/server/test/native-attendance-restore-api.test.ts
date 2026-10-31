import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import { eventPlans, eventPlanEntries, nativeLiveHandoffs, players, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';

describe('TO restoration through the standard native API', () => {
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
  async function change(
    planId: string,
    action: 'withdraw' | 'restore',
    playerId: string,
    reason: string,
    requestId = crypto.randomUUID(),
  ) {
    const input = { planId, action, playerId, reason, requestId };
    const preview = await caller().eventOps.previewAttendance(input);
    return caller().eventOps.applyAttendance({ ...input, revisionToken: preview.revisionToken });
  }

  it('restores only the existing entrant, rejects stale previews, deduplicates the exact request and records actor/time/reason in native history', async () => {
    const planId = await seedNativeDraft(db);
    await caller().eventOps.softLockPools({ planId, confirm: true });
    const before = await live.state(planId);
    const target = before.entrants[0]!;
    await change(planId, 'withdraw', target.playerId, 'Selected the wrong entrant');
    const input = {
      planId,
      action: 'restore' as const,
      playerId: target.playerId,
      reason: 'Corrected accidental withdrawal',
      requestId: 'reviewed-restore',
    };
    const stale = await caller().eventOps.previewAttendance(input);
    expect(stale.allowed).toBe(true);
    await caller().eventOps.live.command({
      planId,
      requestId: 'capacity-changed',
      command: {
        kind: 'configureDispatch',
        capacity: 2,
        reservedStationIds: [],
        expectedResourceRevision: (await live.state(planId)).settings.resourceRevision,
      },
    });
    await expect(
      caller().eventOps.applyAttendance({ ...input, revisionToken: stale.revisionToken }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const preview = await caller().eventOps.previewAttendance(input);
    expect(preview.restoration!.effects.filter((m) => m.effect === 'resumable')).toHaveLength(3);
    const submitted = { ...input, revisionToken: preview.revisionToken };
    const result = await caller().eventOps.applyAttendance(submitted);
    const saved = await live.state(planId);
    expect(await caller().eventOps.applyAttendance(submitted)).toEqual(result);
    expect((await live.state(planId)).sequence).toBe(saved.sequence);
    expect(saved.entrants[0]).toEqual({ ...target, availability: 'available', revision: 2 });
    expect(saved.matches.map((m) => [m.id, m.player1Id, m.player2Id])).toEqual(
      before.matches.map((m) => [m.id, m.player1Id, m.player2Id]),
    );
    const publicData = await caller(null).eventOps.snapshot({ planId });
    expect(publicData.withdrawals.some((w) => w.playerId === target.playerId)).toBe(false);
    const history = await caller().eventOps.live.history({ planId });
    const restored = history.entries.find((entry) => entry.title === 'Entrant restored')!;
    expect(restored).toMatchObject({
      eventName: 'DecisionRecordedV4',
      actor: nativeAdmin.name,
      source: 'operator',
      category: 'players',
    });
    expect(restored.summary).toContain(input.reason);
    expect(Number.isNaN(Date.parse(restored.at))).toBe(false);
    expect(history.entries.filter((entry) => entry.title === 'Entrant restored')).toHaveLength(1);
    expect(await live.replay(planId)).toEqual(saved);
  });

  it('keeps native restore private and explicitly rejects unsupported remote/draft fallbacks without SQL attendance edits', async () => {
    const planId = await seedNativeDraft(db);
    await caller().eventOps.softLockPools({ planId, confirm: true });
    const target = (await live.state(planId)).entrants[0]!.playerId;
    await change(planId, 'withdraw', target, 'Leaving');
    const input = { planId, action: 'restore' as const, playerId: target, reason: 'Returned' };
    await expect(caller(null).eventOps.previewAttendance(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const other = { ...nativeAdmin, id: 'unassigned-restore-user', role: 'user' as const };
    await expect(caller(other).eventOps.previewAttendance(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const preview = await caller().eventOps.previewAttendance(input);
    await expect(
      caller(other).eventOps.applyAttendance({ ...input, revisionToken: preview.revisionToken }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await live.state(planId)).entrants[0]!.availability).toBe('withdrawn');
    const remoteId = await seedNativeDraft(db);
    await db
      .update(eventPlans)
      .set({ bracketMode: 'challonge' })
      .where(eq(eventPlans.id, remoteId));
    const remote = { ...input, planId: remoteId };
    await expect(caller().eventOps.previewAttendance(remote)).rejects.toThrow(/live native events/);
    await expect(
      caller().eventOps.applyAttendance({
        ...remote,
        revisionToken: 'not-an-approved-native-preview',
      }),
    ).rejects.toThrow(/live native events/);
    expect(
      await db
        .select()
        .from(nativeLiveHandoffs)
        .where(eq(nativeLiveHandoffs.eventPlanId, remoteId)),
    ).toHaveLength(0);
  });

  it('retains named additions, no-shows and redistribution history alongside withdrawal/restoration reasons', async () => {
    const planId = await seedNativeDraft(db);
    await db
      .update(eventPlans)
      .set({ poolSize: 3, upperTargetSize: 10 })
      .where(eq(eventPlans.id, planId));
    const promoted = (
      await db.select().from(eventPlanEntries).where(eq(eventPlanEntries.eventPlanId, planId))
    )
      .filter((entry) => entry.assignedDivision === 'lower')
      .slice(0, 2);
    for (const [i, entry] of promoted.entries())
      await db
        .update(eventPlanEntries)
        .set({ assignedDivision: 'upper', divisionSeed: 9 + i })
        .where(eq(eventPlanEntries.id, entry.id));
    await caller().eventOps.softLockPools({ planId, confirm: true });
    let state = await live.state(planId);
    const originalSmall = state.pools.find(
      (p) => p.division === 'upper' && p.entrantIds.length === 3,
    )!;
    const absent = {
      planId,
      action: 'no_show' as const,
      playerId: originalSmall.entrantIds[0]!,
      reason: 'Prepare the two-person pool',
    };
    const absentPreview = await caller().eventOps.previewAttendance(absent);
    await caller().eventOps.applyAttendance({
      ...absent,
      approveRedistribution: false,
      revisionToken: absentPreview.revisionToken,
    });
    state = await live.state(planId);
    const small = state.pools.find((p) => p.id === originalSmall.id)!;
    const redistribution = {
      planId,
      action: 'redistribute' as const,
      playerId: small.entrantIds[0]!,
      reason: 'Move the two-person pool together',
      approveRedistribution: true,
    };
    const move = await caller().eventOps.previewAttendance(redistribution);
    expect(move.relocations).toHaveLength(2);
    await caller().eventOps.applyAttendance({
      ...redistribution,
      revisionToken: move.revisionToken,
    });
    const [late] = await db
      .insert(players)
      .values({ canonicalName: 'Late restoring visitor', displayName: 'Late visitor' })
      .returning();
    const addition = {
      planId,
      action: 'add' as const,
      playerId: late!.id,
      division: 'lower' as const,
      reason: 'Arrived after briefing',
    };
    const add = await caller().eventOps.previewAttendance(addition);
    await caller().eventOps.applyAttendance({ ...addition, revisionToken: add.revisionToken });
    const removal = {
      planId,
      action: 'no_show' as const,
      playerId: late!.id,
      reason: 'Mistaken late-arrival entry',
    };
    const remove = await caller().eventOps.previewAttendance(removal);
    await caller().eventOps.applyAttendance({ ...removal, revisionToken: remove.revisionToken });
    state = await live.state(planId);
    expect(state.entrants.some((e) => e.playerId === late!.id)).toBe(false);
    const target = state.entrants[0]!.playerId;
    await change(planId, 'withdraw', target, 'Temporarily left');
    await change(planId, 'restore', target, 'Returned to the original entry');
    const records = (await caller().eventOps.live.history({ planId })).entries
      .filter((entry) => entry.category === 'players')
      .reverse();
    expect(records).toHaveLength(6);
    expect(records.map((entry) => entry.summary)).toEqual([
      expect.stringContaining(absent.reason),
      expect.stringContaining(redistribution.reason),
      expect.stringContaining(addition.reason),
      expect.stringContaining('Late visitor'),
      expect.stringContaining('Temporarily left'),
      expect.stringContaining('Returned to the original entry'),
    ]);
    expect(
      records.every(
        (entry) => entry.actor === nativeAdmin.name && !Number.isNaN(Date.parse(entry.at)),
      ),
    ).toBe(true);
    const deniedHistory = caller({
      ...nativeAdmin,
      id: 'history-outsider',
      role: 'user',
    }).eventOps.live.history({ planId });
    await expect(deniedHistory).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
