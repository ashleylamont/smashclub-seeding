import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import {
  eventOperators,
  eventPlans,
  eventPlanEntries,
  nativeLiveHandoffs,
  players,
  user,
  type Db,
} from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, nativeStream, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { Decision } from '../src/tournament/schemas';
import { receiptKey } from '../src/tournament/facts';

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
  function caller(actor: typeof nativeAdmin | null = nativeAdmin, nativeRuntime = live) {
    return appRouter.createCaller({
      db,
      nativeRuntime,
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

  it('requires reviewed Add, recovers its exact counts and still checks organiser access on retry', async () => {
    const planId = await seedNativeDraft(db);
    await caller().eventOps.softLockPools({ planId, confirm: true });
    const organiser = {
      ...nativeAdmin,
      id: 'late-add-to',
      email: 'late-add-to@example.test',
      role: 'user' as const,
    };
    await db.insert(user).values(organiser);
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: organiser.id });
    const [late] = await db.insert(players).values({ canonicalName: 'Late arrival' }).returning();
    const input = {
      planId,
      action: 'add' as const,
      playerId: late!.id,
      division: 'upper' as const,
      requestId: 'reviewed-add',
    };
    const api = caller(organiser).eventOps;
    const preview = await api.previewAttendance(input);
    expect(preview.allowed).toBe(true);
    const approved = { ...input, revisionToken: preview.revisionToken };
    const before = await live.replay(planId);
    await expect(
      api.live.command({
        planId,
        requestId: 'forged-add',
        command: {
          ...approved,
          kind: 'attendance',
          reason: 'Fabricated identity',
          approveRedistribution: false,
          entrant: {
            id: crypto.randomUUID(),
            name: 'Invented identity',
            snapshotRank: null,
            snapshotScore: null,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('reviewed attendance'),
    });
    expect(await live.replay(planId)).toEqual(before);
    const original = await api.applyAttendance(approved);
    expect(original).toEqual({
      applied: true,
      addedMatches: preview.addedMatches,
      affectedMatches: 0,
    });
    const saved = await live.replay(planId);
    expect(saved.entrants.find(({ playerId }) => playerId === late!.id)?.name).toBe('Late arrival');
    expect(await api.applyAttendance(approved)).toEqual(original);
    const outsider = { ...organiser, id: 'unassigned-late-add-to' };
    await expect(caller(outsider).eventOps.applyAttendance(approved)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await db.delete(eventOperators).where(eq(eventOperators.eventPlanId, planId));
    await expect(api.applyAttendance(approved)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await live.replay(planId)).toEqual(saved);
  });

  it('replays an older Add receipt without counts and keeps its compatible response', async () => {
    const planId = await seedNativeDraft(db);
    const api = caller().eventOps;
    await api.softLockPools({ planId, confirm: true });
    const [late] = await db
      .insert(players)
      .values({ canonicalName: 'Legacy late arrival' })
      .returning();
    const requestId = 'old-add-receipt';
    const input = {
      planId,
      playerId: late!.id,
      action: 'add' as const,
      division: 'upper' as const,
      requestId,
    };
    const preview = await api.previewAttendance(input);
    const approved = { ...input, revisionToken: preview.revisionToken };
    await api.applyAttendance(approved);

    const stream = nativeStream(planId);
    const facts = await live.app.query_array({ stream, stream_exact: true, after: -1 });
    expect(facts).toHaveLength(2);
    const [baseline, added] = facts;
    const decision = Decision.parse(added!.data);
    expect(decision.requestId).toBe(requestId);
    // Open a fresh runtime on the historical receipt shape with its original intent hash.
    const { attendanceEffect: _counts, ...oldReceipt } = decision.receipt;
    const store = new InMemoryStore();
    await store.commit(stream, [{ name: baseline!.name, data: baseline!.data }], baseline!.meta);
    await store.commit(
      stream,
      [{ name: added!.name, data: { ...decision, receipt: oldReceipt } }],
      added!.meta,
    );
    const legacyRuntime = createNativeRuntime(db, store);
    try {
      const legacyApi = caller(nativeAdmin, legacyRuntime).eventOps;
      const saved = await legacyRuntime.replay(planId);
      const receipt = saved.receipts[receiptKey(nativeAdmin.id, requestId)];
      expect(receipt).toBeDefined();
      expect(receipt).not.toHaveProperty('attendanceEffect');
      const currentPreview = await legacyApi.previewAttendance(input);
      expect(currentPreview.affectedMatches.length).toBeGreaterThan(0);
      expect(await legacyApi.applyAttendance(approved)).toEqual({
        applied: true,
        addedMatches: currentPreview.addedMatches,
        affectedMatches: currentPreview.affectedMatches.length,
      });
      expect(await legacyRuntime.replay(planId)).toEqual(saved);
    } finally {
      await legacyRuntime.shutdown();
    }
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
