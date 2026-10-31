import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import { eventPlans, nativeLiveHandoffs, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';

describe('native broadcast presentation API', () => {
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
    const stationId = crypto.randomUUID();
    await api.eventOps.live.command({
      planId,
      requestId: crypto.randomUUID(),
      command: { kind: 'station', id: stationId, name: 'Stage', expectedResourceRevision: 0 },
    });
    await api.eventOps.live.command({
      planId,
      requestId: crypto.randomUUID(),
      command: {
        kind: 'configureDispatch',
        capacity: 1,
        reservedStationIds: [stationId],
        expectedResourceRevision: 1,
      },
    });
    const before = await api.eventOps.overview({ planId });
    const match = before.matches.find((item) => item.status === 'ready')!;
    await api.eventOps.live.command({
      planId,
      requestId: crypto.randomUUID(),
      command: {
        kind: 'dispatch',
        matchId: match.id,
        stationId,
        expectedRevision: match.revision,
        expectedResourceRevision: before.settings.resourceRevision,
        callOnly: true,
      },
    });
    const command = {
      kind: 'broadcastSides' as const,
      stationId,
      matchId: match.id,
      player1Id: match.player1Id!,
      player2Id: match.player2Id!,
      expectedMatchRevision: match.revision,
      expectedRevision: 0,
      swapped: true,
    };
    return { planId, api, command };
  }
  it('shares only coarse orientation publicly, preserves canonical snapshots, and journals/retries once', async () => {
    const { planId, api, command } = await night();
    const before = await caller(null).eventOps.snapshot({ planId });
    expect(before).not.toHaveProperty('broadcastSides');
    const request = { planId, requestId: 'reliable-side-swap', command };
    const first = await api.eventOps.live.command(request);
    expect((await api.eventOps.live.command(request)).receipt).toEqual(first.receipt);
    const after = await caller(null).eventOps.snapshot({ planId });
    expect(after.matches).toEqual(before.matches);
    expect(after.settings).toEqual(before.settings);
    expect(after.nativeBrackets).toEqual(before.nativeBrackets);
    const publicMetadata = 'broadcastSides' in after ? after.broadcastSides : undefined;
    expect(publicMetadata?.[command.stationId]).toEqual({
      matchId: command.matchId,
      player1Id: command.player1Id,
      player2Id: command.player2Id,
      matchRevision: command.expectedMatchRevision,
      swapped: true,
      revision: 1,
    });
    const direct = await caller(null).eventOps.live.snapshot({ planId });
    expect(direct.broadcastSides).toEqual(publicMetadata);
    expect(direct.audit).toEqual([]);
    expect(JSON.stringify(publicMetadata)).not.toMatch(/actorId|requestId|receipts/);
    const privateView = await api.eventOps.live.overview({ planId });
    expect(privateView.audit.filter((entry) => entry.kind === 'broadcastSides')).toHaveLength(1);
    const history = await api.eventOps.live.history({ planId });
    expect(
      history.entries.filter((entry) => entry.eventName === 'DecisionRecordedV4'),
    ).toMatchObject([
      { category: 'broadcast', title: 'Overlay sides changed', matchId: command.matchId },
    ]);
  });
  it('rejects anonymous, unassigned, stale and wrong-pairing setters', async () => {
    const { planId, api, command } = await night();
    const request = () => ({ planId, requestId: crypto.randomUUID(), command });
    await expect(caller(null).eventOps.live.command(request())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller({ ...nativeAdmin, id: 'unassigned', role: 'user' }).eventOps.live.command(request()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await api.eventOps.live.command(request());
    await expect(api.eventOps.live.command(request())).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.eventOps.live.command({
        ...request(),
        command: { ...command, expectedRevision: 1, player1Id: command.player2Id },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await runtime.state(planId)).broadcastSides?.[command.stationId]?.revision).toBe(1);
  });
  it('does not silently create a native journal for a legacy event', async () => {
    const { command } = await night();
    const planId = await seedNativeDraft(db);
    await db.update(eventPlans).set({ bracketMode: 'challonge' }).where(eq(eventPlans.id, planId));
    await expect(
      caller().eventOps.live.command({ planId, requestId: crypto.randomUUID(), command }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await db.select().from(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toEqual([]);
  });
});
