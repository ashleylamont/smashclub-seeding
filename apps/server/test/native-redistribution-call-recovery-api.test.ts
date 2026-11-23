import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import { eventOperators, eventPlanEntries, eventPlans, user, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';

const organiser = {
  id: 'redistribution-audit-to',
  name: 'Assigned organiser',
  role: 'user' as const,
  email: 'redistribution-audit-to@example.test',
};

describe('recovering two-player pool redistribution from untaken calls', () => {
  let db: Db, close: () => Promise<void>, live: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    live = createNativeRuntime(db, new InMemoryStore());
    await db.insert(user).values(organiser);
  });
  afterAll(async () => {
    await live.shutdown();
    await close();
  });
  function caller(actor = nativeAdmin) {
    return appRouter.createCaller({
      db,
      nativeRuntime: live,
      user: actor,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    }).eventOps;
  }

  async function setup(layout: 'default' | 'alternative' | 'split' = 'default') {
    const planId = await seedNativeDraft(db);
    const upperTargetSize = { default: 6, alternative: 9, split: 12 }[layout];
    const poolSize = layout === 'split' ? 4 : 3;
    await db.update(eventPlans).set({ poolSize, upperTargetSize }).where(eq(eventPlans.id, planId));
    const entries = await db
      .select()
      .from(eventPlanEntries)
      .where(eq(eventPlanEntries.eventPlanId, planId));
    const changes =
      upperTargetSize > 8
        ? entries.filter(
            (e) => e.assignedDivision === 'lower' && e.divisionSeed! <= upperTargetSize - 8,
          )
        : entries.filter(
            (e) => e.assignedDivision === 'upper' && e.divisionSeed! > upperTargetSize,
          );
    for (const [index, entry] of changes.entries())
      await db
        .update(eventPlanEntries)
        .set({
          assignedDivision: upperTargetSize > 8 ? 'upper' : 'lower',
          divisionSeed: 9 + index,
        })
        .where(eq(eventPlanEntries.id, entry.id));
    await caller().softLockPools({ planId, confirm: true });
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: organiser.id });
    const api = caller(organiser);
    const state = () => live.state(planId);
    const command = (command: Parameters<typeof api.live.command>[0]['command']) =>
      api.live.command({ planId, requestId: crypto.randomUUID(), command });
    const initial = await state();
    await command({
      kind: 'configureDispatch',
      capacity: 2,
      reservedStationIds: [],
      expectedResourceRevision: initial.settings.resourceRevision,
    });
    const originalUpper = (await state()).pools.filter(({ division }) => division === 'upper');
    expect(originalUpper.map(({ entrantIds }) => entrantIds.length)).toEqual(
      Array(upperTargetSize / poolSize).fill(poolSize),
    );
    for (const playerId of originalUpper[0]!.entrantIds.slice(2)) {
      const absent = {
        planId,
        action: 'no_show' as const,
        playerId,
        reason: 'Remove the no-show while keeping this pool',
        requestId: crypto.randomUUID(),
        approveRedistribution: false,
      };
      const absentPreview = await api.previewAttendance(absent);
      expect(absentPreview.allowed).toBe(true);
      await api.applyAttendance({ ...absent, revisionToken: absentPreview.revisionToken });
    }
    const open = await state();
    const upper = open.pools.filter(({ division }) => division === 'upper');
    expect(upper.map(({ entrantIds }) => entrantIds.length).sort()).toEqual([
      2,
      ...Array(upperTargetSize / poolSize - 1).fill(poolSize),
    ]);
    const source = upper.find((pool) => pool.entrantIds.length === 2)!;
    const [destination, alternative] = upper
      .filter((pool) => pool.id !== source.id)
      .sort((a, b) => a.index - b.index);
    const move = {
      planId,
      action: 'redistribute' as const,
      playerId: source.entrantIds[0]!,
      reason: 'Redistribute the two entrants together',
      requestId: crypto.randomUUID(),
      approveRedistribution: true,
    };

    async function call(poolId: string, start = false) {
      const snapshot = await state();
      const match = snapshot.matches.find((m) => m.poolId === poolId && m.status === 'ready')!;
      await command({
        kind: 'dispatch',
        matchId: match.id,
        expectedRevision: match.revision,
        expectedResourceRevision: snapshot.settings.resourceRevision,
        expectedOrdinaryCapacity: snapshot.settings.capacity,
        stationId: null,
        callOnly: !start,
      });
      return match.id;
    }

    async function returnCall(matchId: string) {
      const snapshot = await state();
      const match = snapshot.matches.find(({ id }) => id === matchId)!;
      return command({
        kind: 'matchControl',
        matchId,
        expectedRevision: match.revision,
        expectedResourceRevision: snapshot.settings.resourceRevision,
        status: 'ready',
        stationId: null,
        reason: null,
        onlyIfUntaken: true,
      });
    }

    return {
      api,
      state,
      open,
      source,
      destination: destination!,
      alternative,
      move,
      call,
      returnCall,
    };
  }

  it('offers finals removal review and requires a fresh preview of the same redistribution', async () => {
    const { api, state, move } = await setup();
    const original = await api.previewAttendance(move);
    const planId = move.planId;
    const draw = await api.native.preview({ planId });
    await api.native.generate({ planId, revisionToken: draw.revisionToken });
    const drawn = await state();

    const blocked = await api.previewAttendance(move);
    expect(blocked).toMatchObject({
      allowed: false,
      issues: ['Remove unplayed finals before changing the pool draw.'],
      finalsRemoval: { bracketIds: drawn.brackets.map(({ id }) => id).sort() },
    });
    expect(await state()).toEqual(drawn);
    await expect(
      api.applyAttendance({ ...move, revisionToken: blocked.revisionToken }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const removal = await api.native.preview({ planId });
    expect(removal.resetAllowed).toBe(true);
    await api.native.reset({ planId, revisionToken: removal.revisionToken });
    const removed = await state();
    expect(removed.matches).toEqual(drawn.matches.filter(({ bracketId }) => !bracketId));
    await expect(
      api.applyAttendance({ ...move, revisionToken: blocked.revisionToken }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await api.previewAttendance(move)).toMatchObject({
      allowed: true,
      relocations: original.relocations,
    });
    expect(await live.replay(planId)).toEqual(removed);
  });

  it('does not offer finals removal after a finals set starts or finishes', async () => {
    const { api, state, move } = await setup();
    const planId = move.planId;
    const draw = await api.native.preview({ planId });
    await api.native.generate({ planId, revisionToken: draw.revisionToken });
    const before = await state();
    for (const pool of before.pools.filter(({ division }) => division === 'lower')) {
      for (const match of (await state()).matches.filter(({ poolId }) => poolId === pool.id)) {
        const first =
          pool.entrantIds.indexOf(match.player1Id!) < pool.entrantIds.indexOf(match.player2Id!);
        await api.reportScore({
          matchId: match.id,
          expectedRevision: match.revision,
          requestId: crypto.randomUUID(),
          score1: first ? 2 : 0,
          score2: first ? 0 : 2,
          outcome: 'played',
        });
      }
    }
    const ready = await state();
    const match = ready.matches.find(
      ({ bracketId, division, status }) => bracketId && division === 'lower' && status === 'ready',
    )!;
    await api.live.command({
      planId,
      requestId: crypto.randomUUID(),
      command: {
        kind: 'dispatch',
        matchId: match.id,
        expectedRevision: match.revision,
        expectedResourceRevision: ready.settings.resourceRevision,
        expectedOrdinaryCapacity: ready.settings.capacity,
        stationId: null,
        callOnly: false,
      },
    });
    const started = (await state()).matches.find(({ id }) => id === match.id)!;
    expect(started.started).toBe(true);
    const blocked = await api.previewAttendance(move);
    expect(blocked.allowed).toBe(false);
    expect(blocked).not.toHaveProperty('finalsRemoval');
    const removal = await api.native.preview({ planId });
    expect(removal.resetAllowed).toBe(false);
    await expect(
      api.native.reset({ planId, revisionToken: removal.revisionToken }),
    ).rejects.toThrow(/actual play/);

    await api.reportScore({
      matchId: match.id,
      expectedRevision: started.revision,
      requestId: crypto.randomUUID(),
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    expect((await state()).matches.find(({ id }) => id === match.id)).toMatchObject({
      outcome: 'played',
      score1: 2,
      score2: 0,
    });
    const played = await api.previewAttendance(move);
    expect(played.allowed).toBe(false);
    expect(played).not.toHaveProperty('finalsRemoval');
  });

  for (const location of ['source', 'destination'] as const) {
    it(`offers guarded Return when only an untaken ${location} call blocks redistribution`, async () => {
      const event = await setup();
      const { api, state, open, source, destination, move, call, returnCall } = event;
      const initial = await api.previewAttendance(move);
      expect(initial).toMatchObject({ allowed: true, requiresRedistributionApproval: true });
      expect(initial.relocations).toEqual(
        source.entrantIds.map((playerId) => ({
          playerId,
          fromPoolIndex: source.index,
          toPoolIndex: destination.index,
        })),
      );
      const matchId = await call(event[location].id);
      const before = await state();
      expect(before.matches.find(({ id }) => id === matchId)).toMatchObject({
        status: 'playing',
        started: false,
      });
      expect(before.reports).toHaveLength(0);

      const blocked = await api.previewAttendance(move);
      expect(blocked.allowed).toBe(false);
      expect(blocked.relocations).toEqual([]);
      expect(blocked.returnCallMatchIds).toEqual([matchId]);
      expect(blocked.issues).toEqual(['Return the untaken call, then refresh this preview.']);

      await returnCall(matchId);
      const restored = await state();
      expect(restored.sequence).toBe(before.sequence + 1);
      expect(restored.matches.find(({ id }) => id === matchId)).toMatchObject({
        status: 'ready',
        started: false,
      });
      await expect(
        api.applyAttendance({ ...move, revisionToken: blocked.revisionToken }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const refreshed = await api.previewAttendance(move);
      expect(refreshed).toMatchObject({
        allowed: true,
        requiresRedistributionApproval: true,
        relocations: initial.relocations,
      });
      await expect(
        api.applyAttendance({
          ...move,
          approveRedistribution: false,
          revisionToken: refreshed.revisionToken,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await api.applyAttendance({ ...move, revisionToken: refreshed.revisionToken });
      const saved = await state();
      expect(saved.pools.some((p) => p.id === source.id)).toBe(false);
      expect(saved.pools.find(({ id }) => id === destination.id)?.entrantIds).toEqual([
        ...destination.entrantIds,
        ...source.entrantIds,
      ]);
      expect(saved.matches.filter(({ division }) => division === 'lower')).toEqual(
        open.matches.filter(({ division }) => division === 'lower'),
      );
      expect(saved.reports).toEqual(open.reports);
      expect(await live.replay(move.planId)).toEqual(saved);
    });
  }

  it('uses the remaining open pool when another destination has an untaken call', async () => {
    const { api, state, source, destination, alternative, move, call } = await setup('alternative');
    const callId = await call(destination.id);
    const preview = await api.previewAttendance(move);
    expect(preview).toMatchObject({
      allowed: true,
      requiresRedistributionApproval: true,
      relocations: source.entrantIds.map((playerId) => ({
        playerId,
        fromPoolIndex: source.index,
        toPoolIndex: alternative!.index,
      })),
    });
    expect(preview.returnCallMatchIds).toBeUndefined();
    expect((await state()).matches.find(({ id }) => id === callId)).toMatchObject({
      status: 'playing',
      started: false,
    });
  });

  it('offers the first eligible destination without asking to return both pools’ calls', async () => {
    const { api, state, source, destination, alternative, move, call, returnCall } =
      await setup('alternative');
    const firstCall = await call(destination.id);
    const otherCall = await call(alternative!.id);
    const blocked = await api.previewAttendance(move);
    expect(blocked.allowed).toBe(false);
    expect(blocked.returnCallMatchIds).toEqual([firstCall]);
    await returnCall(firstCall);
    const refreshed = await api.previewAttendance(move);
    expect(refreshed).toMatchObject({
      allowed: true,
      relocations: source.entrantIds.map((playerId) => ({
        playerId,
        fromPoolIndex: source.index,
        toPoolIndex: destination.index,
      })),
    });
    expect((await state()).matches.find(({ id }) => id === otherCall)).toMatchObject({
      status: 'playing',
      started: false,
    });
  });

  it('lists both destination calls when the two players have to split across those pools', async () => {
    const { api, source, destination, alternative, move, call, returnCall } = await setup('split');
    const firstCall = await call(destination.id);
    const secondCall = await call(alternative!.id);
    const blocked = await api.previewAttendance(move);
    expect(blocked.returnCallMatchIds).toEqual([firstCall, secondCall]);
    expect(blocked.issues).toEqual(['Return the untaken calls, then refresh this preview.']);
    await returnCall(firstCall);
    expect(await api.previewAttendance(move)).toMatchObject({
      allowed: false,
      returnCallMatchIds: [secondCall],
    });
    await returnCall(secondCall);
    expect(await api.previewAttendance(move)).toMatchObject({
      allowed: true,
      relocations: [
        {
          playerId: source.entrantIds[0],
          fromPoolIndex: source.index,
          toPoolIndex: destination.index,
        },
        {
          playerId: source.entrantIds[1],
          fromPoolIndex: source.index,
          toPoolIndex: alternative!.index,
        },
      ],
    });
  });

  it('keeps actual destination play protected', async () => {
    const { api, state, destination, move, call, returnCall } = await setup();
    const matchId = await call(destination.id, true);
    expect((await state()).matches.find(({ id }) => id === matchId)).toMatchObject({
      status: 'playing',
      started: true,
    });
    const blocked = await api.previewAttendance(move);
    expect(blocked).toMatchObject({ allowed: false, relocations: [] });
    expect(blocked.returnCallMatchIds).toBeUndefined();
    await expect(returnCall(matchId)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
