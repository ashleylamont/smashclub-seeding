import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { inArray } from 'drizzle-orm';
import { players, sets, user, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

describe('native double-elimination grand-final correction through shipped APIs', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
  const attendee: SessionUser = {
    id: 'finals-score-attendee',
    name: 'Finals attendee',
    email: 'finals-score-attendee@example.test',
    role: 'user',
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values([nativeAdmin, attendee]);
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime?.shutdown();
    await close?.();
  });

  const context = (actor: SessionUser) => ({
    db,
    user: actor,
    nativeRuntime: runtime,
    env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(db),
  });
  const caller = (actor = nativeAdmin) => appRouter.createCaller(context(actor));

  async function rpc(path: string, input: object, actor: SessionUser) {
    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      router: appRouter,
      req: new Request(`http://localhost/trpc/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      createContext: () => context(actor),
    });
    return { status: response.status, body: await response.json() };
  }

  async function draftDoubleElimination() {
    const roster = await db
      .insert(players)
      .values(
        ['First seed', 'Second seed'].map((displayName) => ({
          canonicalName: `${displayName} ${crypto.randomUUID()}`,
          displayName,
        })),
      )
      .returning();
    const { planId } = await caller().admin.eventPlanner.createPlan({
      name: 'Double elimination correction',
      eventDate: '2026-10-22T12:00:00Z',
      structure: 'double_elimination',
      rows: roster.map((entrant, index) => ({
        lineNumber: index + 1,
        rawInput: entrant.canonicalName,
        cleanedName: entrant.canonicalName,
        companyId: null,
        playerId: entrant.id,
        resolutionMethod: 'manual',
      })),
    });
    await caller().admin.eventPlanner.freezeRoster({ planId });
    await caller().admin.eventPlanner.generatePools({ planId });
    await caller().eventOps.softLockPools({ planId, confirm: true });
    await caller().eventOps.settings({
      planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    return planId;
  }

  async function scoreOpeningAndGrandFinal(
    planId: string,
    recording: 'operator' | 'review' = 'operator',
  ) {
    for (const bracketLane of ['winners', 'final'] as const) {
      const state = await runtime.state(planId);
      const match = state.matches.find((m) => m.bracketLane === bracketLane)!;
      const score = {
        matchId: match.id,
        expectedRevision: match.revision,
        requestId: crypto.randomUUID(),
        score1: 2,
        score2: 0,
        outcome: 'played' as const,
      };
      if (bracketLane === 'final' && recording === 'review') {
        const pending = await caller(attendee).eventOps.reportScore(score);
        await caller().eventOps.reviewReport({ reportId: pending.id, approve: true });
      } else await caller().eventOps.reportScore(score);
    }
  }

  it('reopens an unplayed double-elimination reset when the grand-final winner changes', async () => {
    const planId = await draftDoubleElimination();
    await scoreOpeningAndGrandFinal(planId);
    const before = await runtime.state(planId);
    const final = before.matches.find((m) => m.bracketLane === 'final')!;
    const reset = before.matches.find((m) => m.bracketLane === 'reset')!;
    expect(final).toMatchObject({ winnerId: final.player1Id, outcome: 'played' });
    expect(reset).toMatchObject({
      status: 'complete',
      outcome: 'no_contest',
      skipped: true,
      player1Id: null,
      player2Id: null,
      resultCommandId: final.resultCommandId,
    });

    const resourceRevision = before.settings.resourceRevision;
    await caller().eventOps.live.command({
      planId,
      requestId: 'configure-finals-dispatch',
      command: {
        kind: 'configureDispatch',
        capacity: 2,
        reservedStationIds: [],
        expectedResourceRevision: resourceRevision,
      },
    });
    const correction = {
      matchId: final.id,
      expectedRevision: final.revision,
      requestId: 'correct-grand-final-winner',
      score1: 0,
      score2: 2,
      outcome: 'played',
    };
    expect((await rpc('eventOps.reportScore', correction, nativeAdmin)).status).toBe(200);
    const live = await runtime.state(planId);
    expect((await rpc('eventOps.reportScore', correction, nativeAdmin)).status).toBe(200);
    expect(await runtime.state(planId)).toEqual(live);
    const corrected = live.matches.find((m) => m.id === final.id)!;
    const reopened = live.matches.find((m) => m.id === reset.id)!;
    expect(corrected).toMatchObject({
      winnerId: final.player2Id,
      score1: 0,
      score2: 2,
      revision: final.revision + 1,
    });
    expect(reopened).toMatchObject({
      status: 'ready',
      outcome: null,
      winnerId: null,
      completedAt: null,
      resultCommandId: null,
      player1Id: final.player2Id,
      player2Id: final.player1Id,
      parent1Id: reset.parent1Id,
      parent2Id: reset.parent2Id,
      activation: reset.activation,
      revision: reset.revision + 1,
    });
    expect(reopened.skipped).toBeFalsy();
    expect(await runtime.replay(planId)).toEqual(live);
    const snapshot = await caller().eventOps.snapshot({ planId });
    expect(snapshot.matches.find((match) => match.id === reset.id)).toMatchObject({
      status: 'ready',
    });
    const desk = await caller().eventOps.live.dispatchDesk({ planId });
    expect(desk.queue.find((match) => match.matchId === reset.id)).toMatchObject({
      state: 'ready',
    });
    expect((await rpc('eventOps.native.finalize', { planId }, nativeAdmin)).status).toBe(409);
    expect(await runtime.state(planId)).toEqual(live);

    const revert = {
      ...correction,
      expectedRevision: corrected.revision,
      requestId: 'restore-grand-final-winner',
      score1: 2,
      score2: 0,
    };
    await caller().eventOps.live.command({
      planId,
      requestId: 'call-grand-final-reset',
      command: {
        kind: 'dispatch',
        matchId: reopened.id,
        expectedRevision: reopened.revision,
        expectedResourceRevision: live.settings.resourceRevision,
        stationId: null,
        callOnly: true,
      },
    });
    const called = await runtime.state(planId);
    expect(await rpc('eventOps.reportScore', revert, nativeAdmin)).toMatchObject({
      status: 409,
      body: { error: { data: { returnUntakenCallMatchIds: [reopened.id] } } },
    });
    expect(await runtime.state(planId)).toEqual(called);
    await caller().eventOps.reportScore({
      matchId: reopened.id,
      expectedRevision: reopened.revision,
      requestId: 'play-grand-final-reset',
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    const played = await runtime.state(planId);
    expect(await rpc('eventOps.reportScore', revert, nativeAdmin)).toMatchObject({
      status: 409,
      body: { error: { message: expect.stringMatching(/downstream actual play/) } },
    });
    expect(await runtime.state(planId)).toEqual(played);
    expect(await caller().eventOps.native.finalize({ planId })).toEqual({
      alreadyFinalized: false,
    });
    expect(await caller().eventOps.native.finalize({ planId })).toEqual({ alreadyFinalized: true });
    const sealed = await runtime.state(planId);
    expect((await rpc('eventOps.reportScore', revert, nativeAdmin)).status).toBe(409);
    expect(await runtime.state(planId)).toEqual(sealed);

    const published = await db
      .select()
      .from(sets)
      .where(inArray(sets.tournamentId, sealed.publication!.tournamentIds));
    expect(published).toHaveLength(3);
    expect(
      published.filter((set) => (set.raw as { eventMatchId: string }).eventMatchId === final.id),
    ).toMatchObject([{ scoresCsv: '0-2', excludedFromRatings: false }]);
    expect(
      published.filter((set) => (set.raw as { eventMatchId: string }).eventMatchId === reset.id),
    ).toMatchObject([{ scoresCsv: '2-1', excludedFromRatings: false }]);
    expect(await runtime.replay(planId)).toEqual(sealed);
  });

  it.each(['operator', 'review'] as const)(
    'reopens the original %s reset skip after a same-winner score edit',
    async (recording) => {
      const planId = await draftDoubleElimination();
      await scoreOpeningAndGrandFinal(planId, recording);
      const closed = await runtime.state(planId);
      const final = closed.matches.find((m) => m.bracketLane === 'final')!;
      const reset = closed.matches.find((m) => m.bracketLane === 'reset')!;
      expect(reset.resultCommandId).toBe(final.resultCommandId);

      await caller().eventOps.reportScore({
        matchId: final.id,
        expectedRevision: final.revision,
        requestId: 'edit-score-with-same-grand-final-winner',
        score1: 2,
        score2: 1,
        outcome: 'played',
      });
      const edited = await runtime.state(planId);
      const updatedFinal = edited.matches.find((m) => m.id === final.id)!;
      expect(updatedFinal.resultCommandId).not.toBe(final.resultCommandId);
      expect(edited.matches.find((m) => m.id === reset.id)).toEqual(reset);

      const corrected = await rpc(
        'eventOps.reportScore',
        {
          matchId: updatedFinal.id,
          expectedRevision: updatedFinal.revision,
          requestId: 'change-winner-after-grand-final-score-edit',
          score1: 0,
          score2: 2,
          outcome: 'played',
        },
        nativeAdmin,
      );
      expect(corrected.status).toBe(200);
      const reopened = await runtime.state(planId);
      expect(reopened.matches.find((m) => m.id === reset.id)).toMatchObject({
        status: 'ready',
        player1Id: final.player2Id,
        player2Id: final.player1Id,
        resultCommandId: null,
        revision: reset.revision + 1,
      });
      expect(await runtime.replay(planId)).toEqual(reopened);
    },
  );
});
