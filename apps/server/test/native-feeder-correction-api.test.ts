import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { players, user, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

const attendee: SessionUser = {
  id: 'reporting-attendee',
  name: 'Attendee',
  email: 'attendee@example.test',
  role: 'user',
};

function score(match: { id: string; revision: number }, score1: number, score2: number) {
  return {
    matchId: match.id,
    expectedRevision: match.revision,
    requestId: crypto.randomUUID(),
    score1,
    score2,
    outcome: 'played' as const,
  };
}

describe('native score reviews during bracket changes through the application API', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values([nativeAdmin, attendee]);
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });

  function caller(user: SessionUser = nativeAdmin) {
    return appRouter.createCaller({
      db,
      nativeRuntime: runtime,
      user,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  }

  async function readyFinal() {
    const entrants = await db
      .insert(players)
      .values(
        Array.from({ length: 4 }, (_, i) => ({
          canonicalName: `Knockout entrant ${crypto.randomUUID()}`,
          displayName: `Entrant ${i + 1}`,
        })),
      )
      .returning();
    const api = caller();
    const { planId } = await api.admin.eventPlanner.createPlan({
      name: 'Feeder correction',
      eventDate: '2026-10-22T12:00:00Z',
      structure: 'single_elimination',
      rows: entrants.map((player, index) => ({
        lineNumber: index + 1,
        rawInput: player.canonicalName,
        cleanedName: player.canonicalName,
        companyId: null,
        playerId: player.id,
        resolutionMethod: 'manual',
      })),
    });
    await api.admin.eventPlanner.freezeRoster({ planId });
    await api.admin.eventPlanner.generatePools({ planId });
    await api.eventOps.softLockPools({ planId, confirm: true });

    for (const match of (await runtime.state(planId)).matches.filter((m) => m.round === 1))
      await api.eventOps.reportScore(score(match, 2, 0));
    const draw = await runtime.state(planId);
    const final = draw.matches.find((m) => m.round === 2)!;
    const feeder = draw.matches.find((m) => m.id === final.parent1Id)!;
    expect(final).toMatchObject({
      status: 'ready',
      started: false,
      player1Id: feeder.player1Id,
      player2Id: expect.any(String),
    });
    const settings = { planId, published: true, playerReports: true };
    return { planId, api, final, feeder, settings };
  }

  async function pendingFinalReport(
    planId: string,
    final: Awaited<ReturnType<typeof readyFinal>>['final'],
  ) {
    await caller().eventOps.settings({
      planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    const report = await caller(attendee).eventOps.reportScore(score(final, 2, 1));
    expect(report).toMatchObject({
      status: 'pending',
      winnerId: final.player1Id,
      expectedRevision: final.revision,
    });
    return report;
  }

  async function expectBlockedCorrection(planId: string, attempt: () => Promise<unknown>) {
    const before = await runtime.state(planId);
    await expect(attempt()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(
        /Review the pending score report for Final before changing this winner/,
      ),
    });
    expect(await runtime.state(planId)).toEqual(before);
    expect(await runtime.replay(planId)).toEqual(before);
  }

  it('protects the pending report during a winner change and retries after rejection', async () => {
    const { planId, api, final, feeder } = await readyFinal();
    const report = await pendingFinalReport(planId, final);
    const reported = await runtime.state(planId);

    await api.eventOps.reportScore(score(feeder, 2, 1));
    const sameWinner = await runtime.state(planId);
    expect(sameWinner.matches.find((m) => m.id === final.id)).toEqual(final);
    const pending = reported.reports.find((r) => r.id === report.id)!;
    expect(sameWinner.reports.find((r) => r.id === report.id)).toEqual(pending);
    const currentFeeder = sameWinner.matches.find((m) => m.id === feeder.id)!;
    expect(currentFeeder).toMatchObject({ score1: 2, score2: 1, winnerId: feeder.winnerId });

    const correction = score(currentFeeder, 0, 2);
    const attempt = () => api.eventOps.reportScore(correction);
    await expectBlockedCorrection(planId, attempt);
    await api.eventOps.reviewReport({ reportId: report.id, approve: false });
    await expect(attempt()).resolves.toMatchObject({
      status: 'approved',
      winnerId: feeder.player2Id,
    });
    const corrected = await runtime.state(planId);
    expect(corrected.matches.find((m) => m.id === final.id)).toMatchObject({
      player1Id: feeder.player2Id,
      player2Id: final.player2Id,
      revision: final.revision + 1,
      status: 'ready',
    });
    expect(corrected.reports.find((r) => r.id === report.id)).toEqual({
      ...pending,
      status: 'rejected',
    });
    expect(await runtime.replay(planId)).toEqual(corrected);
  });

  it('preserves the downstream report for approval when reviewing a feeder dispute', async () => {
    const { planId, api, final, feeder, settings } = await readyFinal();
    await api.eventOps.settings({ ...settings, scoreReportingMode: 'approve_unless_disputed' });
    const dispute = await caller(attendee).eventOps.reportScore(score(feeder, 0, 2));
    expect(dispute.status).toBe('pending');
    const report = await pendingFinalReport(planId, final);
    const approveDispute = () => api.eventOps.reviewReport({ reportId: dispute.id, approve: true });
    await expectBlockedCorrection(planId, approveDispute);

    const approved = await api.eventOps.reviewReport({ reportId: report.id, approve: true });
    expect(approved).toMatchObject({ status: 'approved', winnerId: final.player1Id });
    const played = await runtime.state(planId);
    await expect(approveDispute()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/downstream actual play/),
    });
    expect(await runtime.state(planId)).toEqual(played);
    expect(await runtime.replay(planId)).toEqual(played);
  });

  it('requires review of a reported final before withdrawing the reported winner', async () => {
    const { planId, api, final } = await readyFinal();
    const report = await pendingFinalReport(planId, final);
    const input = {
      planId,
      action: 'withdraw' as const,
      playerId: final.player1Id!,
      reason: 'Entrant needed to leave',
    };
    const before = await runtime.state(planId);
    const preview = await api.eventOps.previewAttendance(input);
    const reviewInstructions = /Approve or reject the pending played score for Final/;
    expect(preview).toMatchObject({
      allowed: false,
      issues: [expect.stringMatching(reviewInstructions)],
    });
    await expect(
      api.eventOps.applyAttendance({ ...input, revisionToken: preview.revisionToken }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(reviewInstructions),
    });
    expect(await runtime.state(planId)).toEqual(before);
    expect(await runtime.replay(planId)).toEqual(before);

    await expect(
      api.eventOps.reviewReport({ reportId: report.id, approve: true }),
    ).resolves.toMatchObject({ status: 'approved', winnerId: final.player1Id });
    const approved = await runtime.state(planId);
    const retry = await api.eventOps.previewAttendance(input);
    expect(retry.allowed).toBe(true);
    await api.eventOps.applyAttendance({ ...input, revisionToken: retry.revisionToken });
    const withdrawn = await runtime.state(planId);
    expect(
      withdrawn.entrants.find((entrant) => entrant.playerId === input.playerId)?.availability,
    ).toBe('withdrawn');
    expect(withdrawn.matches).toEqual(approved.matches);
    expect(withdrawn.matches.find((match) => match.id === final.id)).toMatchObject({
      outcome: 'played',
      winnerId: final.player1Id,
      score1: 2,
      score2: 1,
    });
    expect(await runtime.replay(planId)).toEqual(withdrawn);
  });

  it('rejects a withdrawal preview taken before a report and permits the forfeit after rejection', async () => {
    const { planId, api, final } = await readyFinal();
    const input = {
      planId,
      action: 'withdraw' as const,
      playerId: final.player1Id!,
      requestId: crypto.randomUUID(),
    };
    const preview = await api.eventOps.previewAttendance(input);
    expect(preview.allowed).toBe(true);
    const report = await pendingFinalReport(planId, final);
    const before = await runtime.state(planId);

    await expect(
      api.eventOps.applyAttendance({ ...input, revisionToken: preview.revisionToken }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/since this preview/),
    });
    expect(await runtime.state(planId)).toEqual(before);
    expect(await runtime.replay(planId)).toEqual(before);

    await api.eventOps.reviewReport({ reportId: report.id, approve: false });
    const retry = await api.eventOps.previewAttendance(input);
    expect(retry.allowed).toBe(true);
    await api.eventOps.applyAttendance({ ...input, revisionToken: retry.revisionToken });
    const forfeited = await runtime.state(planId);
    expect(forfeited.matches.find((match) => match.id === final.id)).toMatchObject({
      outcome: 'forfeit',
      winnerId: final.player2Id,
      score1: null,
      score2: null,
      revision: final.revision + 1,
    });
    expect(forfeited.reports.find((item) => item.id === report.id)?.status).toBe('rejected');
    expect(await runtime.replay(planId)).toEqual(forfeited);
  });

  it('protects the pending final from a direct live availability withdrawal', async () => {
    const { planId, api, final } = await readyFinal();
    const report = await pendingFinalReport(planId, final);
    const before = await runtime.state(planId);
    const entrant = before.entrants.find(({ playerId }) => playerId === final.player1Id)!;
    const input = {
      planId,
      requestId: crypto.randomUUID(),
      command: {
        kind: 'availability' as const,
        playerId: entrant.playerId,
        expectedRevision: entrant.revision,
        availability: 'withdrawn' as const,
        reason: 'Entrant needed to leave',
      },
    };
    await expect(api.eventOps.live.command(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/Approve or reject the pending played score for Final/),
    });
    expect(await runtime.state(planId)).toEqual(before);
    expect(await runtime.replay(planId)).toEqual(before);
    await api.eventOps.reviewReport({ reportId: report.id, approve: false });
    await api.eventOps.live.command(input);
    const withdrawn = await runtime.state(planId);
    expect(withdrawn.matches.find((match) => match.id === final.id)).toMatchObject({
      outcome: 'forfeit',
      winnerId: final.player2Id,
      score1: null,
      score2: null,
    });
    expect(await runtime.replay(planId)).toEqual(withdrawn);
  });

  it.each([false, true])(
    'permits withdrawal alongside an unaffected report and a resolved feeder dispute (stale=%s)',
    async (stale) => {
      const { planId, api, final, feeder, settings } = await readyFinal();
      await api.eventOps.settings({ ...settings, scoreReportingMode: 'approve_unless_disputed' });
      const dispute = await caller(attendee).eventOps.reportScore(score(feeder, 0, 2));
      expect(dispute.status).toBe('pending');
      if (stale) await api.eventOps.reportScore(score(feeder, 2, 1));
      await pendingFinalReport(planId, final);
      const before = await runtime.state(planId);
      const input = { planId, action: 'withdraw' as const, playerId: feeder.player2Id! };
      const preview = await api.eventOps.previewAttendance(input);
      expect(preview.allowed).toBe(true);
      await api.eventOps.applyAttendance({ ...input, revisionToken: preview.revisionToken });
      const withdrawn = await runtime.state(planId);
      expect(
        withdrawn.entrants.find((entrant) => entrant.playerId === input.playerId)?.availability,
      ).toBe('withdrawn');
      expect(withdrawn.matches).toEqual(before.matches);
      expect(withdrawn.reports).toEqual(before.reports);
      expect(await runtime.replay(planId)).toEqual(withdrawn);
    },
  );
});
