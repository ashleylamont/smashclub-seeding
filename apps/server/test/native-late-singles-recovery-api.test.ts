import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eventOperators, players, user, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

const organiser: SessionUser = {
  id: 'late-singles-organiser',
  name: 'Assigned organiser',
  role: 'user',
  email: 'late-singles-organiser@example.test',
};
const attendee: SessionUser = {
  id: 'late-singles-attendee',
  name: 'Reporting attendee',
  role: 'user',
  email: 'late-singles-attendee@example.test',
};

describe('late singles call recovery through the native event API', () => {
  let db: Db, runtime: NativeRuntime, close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values([nativeAdmin, organiser, attendee]);
    runtime = createNativeRuntime(db, new InMemoryStore());
  });

  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });

  function caller(user: SessionUser) {
    return appRouter.createCaller({
      db,
      user,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  }

  async function roundRobinDraft() {
    const roster = await db
      .insert(players)
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          canonicalName: `Early entrant ${index} ${crypto.randomUUID()}`,
        })),
      )
      .returning();
    const planner = caller(nativeAdmin).admin.eventPlanner;
    const { planId } = await planner.createPlan({
      name: 'Late singles rehearsal',
      eventDate: '2026-10-22T12:00:00Z',
      structure: 'round_robin_finals',
      structureOptions: { roundRobinMeetings: 1, playoffSize: 4 },
      competitionFormat: 'singles',
      rows: roster.map((player, index) => ({
        lineNumber: index + 1,
        rawInput: player.canonicalName,
        cleanedName: player.canonicalName,
        companyId: null,
        playerId: player.id,
        resolutionMethod: 'manual',
      })),
    });
    await planner.freezeRoster({ planId });
    await planner.generatePools({ planId });
    return planId;
  }

  async function setup(planId: string) {
    const admin = caller(nativeAdmin).eventOps;
    await admin.softLockPools({ planId, confirm: true });
    await admin.settings({
      planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: organiser.id });
    const [late] = await db
      .insert(players)
      .values({ canonicalName: 'Late singles entrant' })
      .returning();
    const api = caller(organiser).eventOps;
    const state = () => runtime.state(planId);
    const command = (command: Parameters<typeof api.live.command>[0]['command']) =>
      api.live.command({ planId, requestId: crypto.randomUUID(), command });
    const initial = await state();
    await command({
      kind: 'configureDispatch',
      capacity: 2,
      reservedStationIds: [],
      expectedResourceRevision: initial.settings.resourceRevision,
    });
    const open = await state();
    const change = {
      planId,
      playerId: late!.id,
      action: 'add' as const,
      division: open.pools[0]!.division,
      requestId: 'late-singles',
      reason: 'Arrived after the draw was locked',
    };
    const call = async (matchId: string) => {
      const current = await state();
      await command({
        kind: 'dispatch',
        matchId,
        expectedRevision: current.matches.find(({ id }) => id === matchId)!.revision,
        expectedResourceRevision: current.settings.resourceRevision,
        expectedOrdinaryCapacity: current.settings.capacity,
        stationId: null,
        callOnly: true,
      });
    };
    const controls = (current: Awaited<ReturnType<typeof state>>, matchId: string) => ({
      matchId,
      expectedRevision: current.matches.find(({ id }) => id === matchId)!.revision,
      expectedResourceRevision: current.settings.resourceRevision,
    });
    const returnCall = (inputs: ReturnType<typeof controls>) =>
      command({
        kind: 'matchControl',
        ...inputs,
        status: 'ready',
        stationId: null,
        reason: null,
        onlyIfUntaken: true,
      });
    return { api, call, change, command, controls, open, returnCall, state };
  }

  it('identifies both untaken calls and requires a fresh review after a guarded return', async () => {
    const { api, call, change, controls, open, returnCall, state } = await setup(
      await roundRobinDraft(),
    );
    const first = open.matches[0]!;
    const pair = new Set([first.player1Id, first.player2Id]);
    const second = open.matches.find(
      (match) => !pair.has(match.player1Id) && !pair.has(match.player2Id),
    )!;
    expect(await api.previewAttendance(change)).toMatchObject({ allowed: true, addedMatches: 4 });
    await call(first.id);
    await call(second.id);

    const called = await state();
    const blocked = await api.previewAttendance(change);
    expect(blocked).toMatchObject({
      allowed: false,
      issues: [expect.stringMatching(/Return the untaken calls in Pool A/)],
      returnCallMatchIds: expect.arrayContaining([first.id, second.id]),
      poolIndex: null,
    });
    expect(blocked.returnCallMatchIds).toHaveLength(2);
    await expect(caller(attendee).eventOps.previewAttendance(change)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const stale = { ...change, revisionToken: blocked.revisionToken };
    await expect(api.applyAttendance(stale)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await state()).toEqual(called);

    await returnCall(controls(called, first.id));
    expect((await api.previewAttendance(change)).returnCallMatchIds).toEqual([second.id]);
    await returnCall(controls(await state(), second.id));
    const returned = await state();
    expect(returned.reports).toEqual(called.reports);
    expect(returned.entrants).toEqual(called.entrants);
    await expect(api.applyAttendance(stale)).rejects.toThrow(/changed since this preview/);

    const reviewed = await api.previewAttendance(change);
    expect(reviewed).toMatchObject({ allowed: true, poolIndex: 0, addedMatches: 4 });
    const approved = { ...change, revisionToken: reviewed.revisionToken };
    const receipt = await api.applyAttendance(approved);
    expect(receipt).toEqual({ applied: true, addedMatches: 4, affectedMatches: 0 });
    const admitted = await state();
    expect(admitted.matches.slice(0, returned.matches.length)).toEqual(returned.matches);
    expect(admitted.matches.slice(returned.matches.length)).toHaveLength(4);
    for (const match of admitted.matches.slice(returned.matches.length))
      expect([match.player1Id, match.player2Id]).toContain(change.playerId);
    expect(await api.applyAttendance(approved)).toEqual(receipt);
    expect(await runtime.replay(change.planId)).toEqual(admitted);
  });

  it('rejects a stale return once play starts and keeps the actual start when releasing capacity', async () => {
    const { api, call, change, command, controls, open, returnCall, state } = await setup(
      await roundRobinDraft(),
    );
    const first = open.matches[0]!;
    await call(first.id);
    const called = await state();
    expect((await api.previewAttendance(change)).returnCallMatchIds).toEqual([first.id]);

    await command({ kind: 'beginPlay', ...controls(called, first.id) });
    const started = await state();
    await expect(returnCall(controls(called, first.id))).rejects.toThrow(/resources changed/i);
    expect(await state()).toEqual(started);
    expect((await api.previewAttendance(change)).returnCallMatchIds).toBeUndefined();

    await expect(returnCall(controls(started, first.id))).rejects.toThrow(/call changed/i);
    await command({
      kind: 'matchControl',
      ...controls(started, first.id),
      status: 'ready',
      stationId: null,
      reason: null,
    });
    const released = await state();
    expect(released.matches.find(({ id }) => id === first.id)).toMatchObject({ started: true });
    expect(await api.previewAttendance(change)).toMatchObject({ allowed: false });
    expect((await api.previewAttendance(change)).returnCallMatchIds).toBeUndefined();
    expect(await runtime.replay(change.planId)).toEqual(released);
  });

  it('keeps a called pairing in place when its score reaches review after the attendance preview', async () => {
    const { api, call, change, controls, open, returnCall, state } = await setup(
      await roundRobinDraft(),
    );
    const { id } = open.matches[0]!;
    await call(id);
    const called = await state();
    const basis = controls(called, id);
    expect((await api.previewAttendance(change)).returnCallMatchIds).toEqual([id]);

    const report = await caller(attendee).eventOps.reportScore({
      matchId: id,
      expectedRevision: basis.expectedRevision,
      requestId: 'called-match-score-reported',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    expect(report.status).toBe('pending');
    const awaitingReview = await state();
    expect(controls(awaitingReview, id)).toEqual(basis);
    expect(await api.previewAttendance(change)).toMatchObject({ allowed: false });
    expect((await api.previewAttendance(change)).returnCallMatchIds).toBeUndefined();
    await expect(returnCall(basis)).rejects.toThrow(/pending score report/);
    expect(await state()).toEqual(awaitingReview);

    await api.reviewReport({ reportId: report.id, approve: false });
    await returnCall(controls(await state(), id));
    const returned = await state();
    expect(returned.matches.find((match) => match.id === id)).toMatchObject({
      status: 'ready',
      started: false,
    });
    expect(returned.reports.find((entry) => entry.id === report.id)?.status).toBe('rejected');
    expect(await api.previewAttendance(change)).toMatchObject({ allowed: false });
    expect(await runtime.replay(change.planId)).toEqual(returned);
  });

  it('chooses another open pool and skips calls in pools with reports', async () => {
    const { api, call, change, open, controls, returnCall, state } = await setup(
      await seedNativeDraft(db),
    );
    const eligible = open.pools.filter((pool) => pool.division === change.division);
    expect(eligible).toHaveLength(2);
    const [first, second] = eligible;
    const [firstCall, reportedMatch] = open.matches.filter(({ poolId }) => poolId === first!.id);
    const secondCall = open.matches.find(({ poolId }) => poolId === second!.id)!;
    await call(firstCall!.id);

    const preview = await api.previewAttendance(change);
    expect(preview).toMatchObject({ allowed: true, poolIndex: second!.index });
    expect(preview.returnCallMatchIds).toBeUndefined();

    await call(secondCall.id);
    expect((await api.previewAttendance(change)).returnCallMatchIds).toEqual([firstCall!.id]);
    const report = await caller(attendee).eventOps.reportScore({
      matchId: reportedMatch!.id,
      expectedRevision: reportedMatch!.revision,
      requestId: 'pool-score-reported',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    expect(report.status).toBe('pending');
    const reported = await state();
    const blocked = await api.previewAttendance(change);
    expect(blocked.allowed).toBe(false);
    expect(blocked.returnCallMatchIds).toEqual([secondCall.id]);
    await returnCall(controls(reported, secondCall.id));
    const reviewed = await api.previewAttendance(change);
    expect(reviewed).toMatchObject({ allowed: true, poolIndex: second!.index });
    await api.applyAttendance({ ...change, revisionToken: reviewed.revisionToken });
    const admitted = await state();
    expect(admitted.reports).toEqual(reported.reports);
    expect(admitted.matches.find(({ id }) => id === firstCall!.id)).toEqual(
      reported.matches.find(({ id }) => id === firstCall!.id),
    );
    expect(await runtime.replay(change.planId)).toEqual(admitted);
  });
});
