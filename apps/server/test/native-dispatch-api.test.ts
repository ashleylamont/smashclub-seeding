import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { inArray } from 'drizzle-orm';
import { eventOperators, players, sets, user, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { loadSinglesHistory } from '../src/recompute/inputs';
import { charactersForPlayer } from '../src/players/characters';

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

  async function knockout(count: number) {
    await db.insert(user).values(nativeAdmin).onConflictDoNothing();
    const entrants = await db
      .insert(players)
      .values(Array.from({ length: count }, () => ({ canonicalName: crypto.randomUUID() })))
      .returning();
    const { admin, eventOps } = caller();
    const { planId } = await admin.eventPlanner.createPlan({
      name: 'Knockout score correction',
      eventDate: '2026-10-22T12:00:00Z',
      structure: 'single_elimination',
      rows: entrants.map((player, i) => ({
        lineNumber: i + 1,
        rawInput: player.canonicalName,
        cleanedName: player.canonicalName,
        companyId: null,
        playerId: player.id,
        resolutionMethod: 'manual',
      })),
    });
    await admin.eventPlanner.freezeRoster({ planId });
    await admin.eventPlanner.generatePools({ planId });
    await eventOps.softLockPools({ planId, confirm: true });
    return planId;
  }

  it('keeps the original played time when a live feeder score is corrected', async () => {
    const planId = await knockout(4);
    const { eventOps } = caller();
    const locked = await runtime.state(planId);
    await eventOps.live.command({
      planId,
      requestId: 'enable-shared-dispatch',
      command: {
        kind: 'configureDispatch',
        capacity: 2,
        reservedStationIds: [],
        expectedResourceRevision: locked.settings.resourceRevision,
      },
    });
    const report = (match: (typeof locked.matches)[number], score2: number) =>
      eventOps.reportScore({
        matchId: match.id,
        expectedRevision: match.revision,
        requestId: crypto.randomUUID(),
        score1: 2,
        score2,
        outcome: 'played',
      });
    const playedAt = Date.now() + 30_000;
    const correctedAt = playedAt + 600_000;
    try {
      vi.setSystemTime(playedAt);
      for (const match of locked.matches.filter((m) => m.round === 1)) await report(match, 0);
      const before = await runtime.state(planId);
      const final = before.matches.find((m) => m.round === 2)!;
      const feeder = before.matches.find((m) => m.id === final.parent1Id)!;
      const finalQueueRow = async () =>
        (await eventOps.live.dispatchDesk({ planId })).queue.find(
          (row) => row.matchId === final.id,
        );
      expect(feeder.completedAt).toBe(playedAt);
      expect(await finalQueueRow()).toMatchObject({ state: 'ready', waitingSince: playedAt });

      vi.setSystemTime(correctedAt);
      const correction = await report(feeder, 1);
      const after = await runtime.state(planId);
      expect(correction.createdAt).toEqual(new Date(correctedAt));
      expect(after.matches.find((m) => m.id === feeder.id)).toMatchObject({
        score1: 2,
        score2: 1,
        winnerId: feeder.winnerId,
        revision: feeder.revision + 1,
        resultCommandId: correction.id,
        completedAt: playedAt,
      });
      expect(after.matches.find((m) => m.id === final.id)).toEqual(final);
      expect(await finalQueueRow()).toMatchObject({ state: 'ready', waitingSince: playedAt });
      expect((await eventOps.live.history({ planId })).entries).toContainEqual(
        expect.objectContaining({
          matchId: feeder.id,
          at: new Date(correctedAt).toISOString(),
          details: expect.objectContaining({
            commandId: correction.id,
            correctionOf: feeder.resultCommandId,
          }),
        }),
      );

      await report(final, 0);
      await eventOps.native.finalize({ planId });
      const sealed = await runtime.state(planId);
      const published = await db
        .select()
        .from(sets)
        .where(inArray(sets.tournamentId, sealed.publication!.tournamentIds));
      const publishedFeeder = published.find(
        (row) => (row.raw as { eventMatchId: string }).eventMatchId === feeder.id,
      )!;
      expect(publishedFeeder).toMatchObject({
        scoresCsv: '2-1',
        completedAt: new Date(playedAt),
        excludedFromRatings: false,
      });
      const { engineSets } = await loadSinglesHistory(db);
      expect(engineSets.find((row) => row.id === publishedFeeder.id)).toMatchObject({
        completedAt: new Date(playedAt).toISOString(),
        p1Games: 2,
        p2Games: 1,
      });
      expect(await runtime.replay(planId)).toEqual(sealed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stamps a new completion time when an organiser changes the recorded outcome', async () => {
    const planId = await knockout(2);
    const { eventOps } = caller();
    const ready = (await runtime.state(planId)).matches.find((m) => m.status === 'ready')!;
    const playedAt = Date.now() + 30_000;
    try {
      vi.setSystemTime(playedAt);
      await eventOps.reportScore({
        matchId: ready.id,
        expectedRevision: ready.revision,
        requestId: 'record-played-result',
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
      const forfeitedAt = playedAt + 600_000;
      vi.setSystemTime(forfeitedAt);
      await eventOps.reportScore({
        matchId: ready.id,
        expectedRevision: ready.revision + 1,
        requestId: 'replace-with-forfeit',
        score1: 0,
        score2: 0,
        winnerId: ready.player1Id!,
        outcome: 'forfeit',
      });
      const correctedToPlayedAt = forfeitedAt + 600_000;
      vi.setSystemTime(correctedToPlayedAt);
      const forfeited = (await runtime.state(planId)).matches.find((m) => m.id === ready.id)!;
      expect(forfeited).toMatchObject({ outcome: 'forfeit', completedAt: forfeitedAt });
      await eventOps.reportScore({
        matchId: ready.id,
        expectedRevision: forfeited.revision,
        requestId: 'replace-with-played-result',
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
      expect((await runtime.state(planId)).matches.find((m) => m.id === ready.id)).toMatchObject({
        outcome: 'played',
        completedAt: correctedToPlayedAt,
      });
    } finally {
      vi.useRealTimers();
    }
  });

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
    expect(before.matches.find((m) => m.id === match.id)).not.toHaveProperty('callSequence');
    const request = {
      planId,
      requestId: 'call-at-window',
      command: {
        kind: 'dispatch' as const,
        matchId: match.id,
        expectedRevision: match.revision,
        stationId: null,
        expectedResourceRevision: before.settings.resourceRevision,
        expectedOrdinaryCapacity: before.sharedDispatch!.capacity,
        callOnly: true,
        callLocation: 'Window',
      },
    };
    const first = await api.eventOps.live.command(request);
    expect((await api.eventOps.live.command(request)).receipt).toEqual(first.receipt);
    await expect(
      api.eventOps.live.command({
        ...request,
        command: { ...request.command, expectedOrdinaryCapacity: 1 },
      }),
    ).rejects.toThrow(/request identifier already used/i);
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
    expect(board.callSnapshotVersion).toBeGreaterThan(first.receipt.sequence);
    expect(board.matches.find((m) => m.id === match.id)).toMatchObject({
      status: 'playing',
      started: false,
      called: true,
      callSequence: first.receipt.sequence,
      callLocation: 'Window',
      stationId: null,
    });
    expect(board.sharedDispatch).toMatchObject({ active: 1, capacity: 2 });
    const direct = await caller(null).eventOps.live.snapshot({ planId });
    expect(direct.matches.find((m) => m.id === match.id)).not.toHaveProperty('callSequence');
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
    const returned = await caller(null).eventOps.snapshot({ planId });
    expect(returned.sharedDispatch!.active).toBe(0);
    expect(returned.matches.find((m) => m.id === match.id)).not.toHaveProperty('callSequence');
    expect((await runtime.state(planId)).matches.find((m) => m.id === match.id)).toMatchObject({
      started: false,
      calledAt: null,
      callLocation: null,
    });
    await api.eventOps.live.command(request);
    expect(await caller(null).eventOps.snapshot({ planId })).toEqual(returned);

    const nextCall = await api.eventOps.live.command({
      ...request,
      requestId: 'call-again-at-window',
      command: {
        ...request.command,
        expectedRevision: returned.matches.find((m) => m.id === match.id)!.revision,
      },
    });
    const recalled = await caller(null).eventOps.snapshot({ planId });
    expect(recalled.matches.find((m) => m.id === match.id)?.callSequence).toBe(
      nextCall.receipt.sequence,
    );
    expect(nextCall.receipt.sequence).toBeGreaterThan(first.receipt.sequence);
    await api.eventOps.live.command({
      planId,
      requestId: 'start-recalled-match',
      command: {
        kind: 'beginPlay',
        matchId: match.id,
        expectedRevision: recalled.matches.find((m) => m.id === match.id)!.revision,
        expectedResourceRevision: recalled.settings.resourceRevision,
      },
    });
    const started = await caller(null).eventOps.snapshot({ planId });
    expect(started.matches.find((m) => m.id === match.id)).toMatchObject({
      started: true,
      called: false,
    });
    expect(started.matches.find((m) => m.id === match.id)).not.toHaveProperty('callSequence');
    const state = await runtime.state(planId);
    expect(await runtime.replay(planId)).toEqual(state);
  });

  it('lets the assigned TO fill a missing main only after play starts', async () => {
    const { planId, api } = await night();
    const organiser = {
      ...nativeAdmin,
      id: 'main-confirming-to',
      role: 'user' as const,
      email: 'main-to@example.test',
    };
    await db.insert(user).values(organiser);
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: organiser.id });
    const to = caller(organiser).eventOps;
    const desk = await api.eventOps.live.dispatchDesk({ planId });
    const before = await runtime.state(planId);
    const match = before.matches.find(({ id }) => id === desk.queue[0]!.matchId)!;
    const input = { planId, matchId: match.id, playerId: match.player1Id!, character: 'fox' };
    await expect(caller(null).eventOps.live.confirmMatchMain(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller({ ...organiser, id: 'unassigned' }).eventOps.live.confirmMatchMain(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await api.eventOps.live.command({
      planId,
      requestId: 'call-for-main-confirmation',
      command: {
        kind: 'dispatch',
        matchId: match.id,
        expectedRevision: match.revision,
        stationId: null,
        expectedResourceRevision: desk.resourceRevision,
        expectedOrdinaryCapacity: desk.capacity,
        callOnly: true,
      },
    });
    const called = await runtime.state(planId);
    await expect(to.live.confirmMatchMain(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await api.eventOps.live.command({
      planId,
      requestId: 'start-for-main-confirmation',
      command: {
        kind: 'beginPlay',
        matchId: match.id,
        expectedRevision: called.matches.find(({ id }) => id === match.id)!.revision,
        expectedResourceRevision: called.settings.resourceRevision,
      },
    });
    const playing = await runtime.state(planId);
    const overview = await to.overview({ planId });
    const playingMatch = overview.matches.find(({ id }) => id === match.id)!;
    expect('missingMains' in overview && overview.missingMains[match.id]).toContainEqual({
      playerId: input.playerId,
      name: playingMatch.player1Name,
    });
    const otherPlayer = before.entrants.find(
      ({ playerId }) => playerId !== match.player1Id && playerId !== match.player2Id,
    )!;
    await expect(
      to.live.confirmMatchMain({ ...input, playerId: otherPlayer.playerId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      to.live.confirmMatchMain({ ...input, character: 'unknown-fighter' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(to.live.confirmMatchMain(input)).resolves.toEqual({ ok: true });
    await expect(to.live.confirmMatchMain(input)).resolves.toEqual({ ok: true });
    await expect(to.live.confirmMatchMain({ ...input, character: 'falco' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await charactersForPlayer(db, input.playerId)).toEqual(['fox']);
    const after = await to.overview({ planId });
    expect('missingMains' in after && after.missingMains[match.id]).toEqual([
      { playerId: match.player2Id, name: playingMatch.player2Name },
    ]);
    const publicBoard = await caller(null).eventOps.snapshot({ planId });
    const publicMatch = publicBoard.matches.find(({ id }) => id === match.id)!;
    expect(publicMatch.player1Characters).toEqual(['fox']);
    expect(publicBoard).not.toHaveProperty('missingMains');
    expect(await runtime.state(planId)).toEqual(playing);
  });

  it('reports a setup-only reset and retains match IDs and pairings', async () => {
    const { planId, api } = await night();
    const original = await runtime.state(planId);
    const match = original.matches[0]!;
    const pool = original.pools.find(({ id }) => id === match.poolId)!;
    await api.eventOps.live.command({
      planId,
      requestId: 'hold-pool-before-reset',
      command: {
        kind: 'poolResources',
        poolId: pool.id,
        active: false,
        stationIds: [],
        selfRun: false,
        autoAcceptScores: false,
        expectedResourceRevision: original.settings.resourceRevision,
      },
    });
    expect((await runtime.state(planId)).pools.find(({ id }) => id === pool.id)?.active).toBe(
      false,
    );

    const request = { planId, requestId: 'reset-queue' };
    await expect(
      caller({ ...nativeAdmin, id: 'unassigned-player', role: 'user' }).eventOps.resetOperations(
        request,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const result = await api.eventOps.resetOperations(request);
    expect(result).toEqual({ effect: 'setup_only', deletedMatches: 0, removedMatches: 0 });
    const reset = await runtime.state(planId);
    const pairings = (state: typeof reset) =>
      state.matches.map(({ id, player1Id, player2Id }) => [id, player1Id, player2Id]);
    expect(pairings(reset)).toEqual(pairings(original));
    expect(reset.pools.find(({ id }) => id === pool.id)?.active).toBe(true);
    expect(await api.eventOps.resetOperations(request)).toEqual(result);
    expect(await runtime.state(planId)).toEqual(reset);

    await api.eventOps.reportScore({
      matchId: match.id,
      expectedRevision: reset.matches.find(({ id }) => id === match.id)!.revision,
      requestId: 'result-after-reset',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    const played = await runtime.state(planId);
    await expect(
      api.eventOps.resetOperations({ planId, requestId: 'reset-after-play' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await runtime.state(planId)).toEqual(played);
  });

  it('offers the exact no-show call to an organiser and requires a fresh attendance review after returning it', async () => {
    const { planId, api } = await night();
    const before = await api.eventOps.overview({ planId });
    const match = before.matches.find((row) => row.status === 'ready')!;
    const draft = {
      planId,
      requestId: 'no-show-draft',
      action: 'no_show' as const,
      playerId: match.player1Id!,
      reason: 'Did not arrive',
    };
    await api.eventOps.live.command({
      planId,
      requestId: 'call-before-no-show',
      command: {
        kind: 'dispatch',
        matchId: match.id,
        stationId: null,
        callOnly: true,
        expectedRevision: match.revision,
        expectedResourceRevision: before.settings.resourceRevision,
        expectedOrdinaryCapacity: before.sharedDispatch!.capacity,
      },
    });
    const blocked = await api.eventOps.previewAttendance(draft);
    expect(blocked).toMatchObject({ allowed: false, returnCallMatchIds: [match.id] });
    await expect(caller(null).eventOps.previewAttendance(draft)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const other = caller({ ...nativeAdmin, id: 'unassigned-player', role: 'user' });
    await expect(other.eventOps.previewAttendance(draft)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const oldRequest = { ...draft, revisionToken: blocked.revisionToken };
    await expect(api.eventOps.applyAttendance(oldRequest)).rejects.toThrow(/untaken call/);
    const called = await runtime.state(planId);
    await api.eventOps.updateMatch({
      matchId: match.id,
      status: 'ready',
      stationId: null,
      expectedRevision: called.matches.find(({ id }) => id === match.id)!.revision,
      expectedResourceRevision: called.settings.resourceRevision,
    });
    const returned = await runtime.state(planId);
    expect(returned.entrants).toEqual(called.entrants);
    expect(returned.matches.map(({ id }) => id)).toEqual(called.matches.map(({ id }) => id));
    await expect(api.eventOps.applyAttendance(oldRequest)).rejects.toThrow(
      /changed since this preview/,
    );
    const refreshed = await api.eventOps.previewAttendance(draft);
    expect(refreshed.allowed).toBe(true);
    expect(refreshed).not.toHaveProperty('returnCallMatchIds');
    const approvedRequest = { ...draft, revisionToken: refreshed.revisionToken };
    await api.eventOps.applyAttendance(approvedRequest);
    const after = await runtime.state(planId);
    expect(after.matches).toEqual(
      returned.matches.filter((row) => ![row.player1Id, row.player2Id].includes(draft.playerId)),
    );
    expect(after.entrants.some(({ playerId }) => playerId === draft.playerId)).toBe(false);
    await api.eventOps.applyAttendance(approvedRequest);
    expect(await runtime.state(planId)).toEqual(after);
    expect(await runtime.replay(planId)).toEqual(after);
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
