import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { InMemoryStore } from '@rotorsoft/act';
import {
  eventMatches,
  eventPlans,
  eventOperationSettings,
  nativeLiveHandoffs,
  players,
  sets,
  nativeRatingIntents,
  nativeResultPublications,
  eventAnnouncements,
  eventPrizes,
  tournaments,
  type Db,
} from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { softLockPools } from '../src/event-operations/attendance';
import { reportScore } from '../src/event-operations/service';
import { getPlan, savePoolPlacements } from '../src/event-planner/plans';
import {
  generateNativeBrackets,
  finalizeNativeEvent,
  previewNativeBrackets,
} from '../src/event-operations/nativeBrackets';
import { processNativeRatingIntents } from '../src/tournament/publication';

describe('standard native lifecycle uses Act without adoption', () => {
  let db: Db, close: () => Promise<void>;
  let runtime: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });
  function caller(user: typeof nativeAdmin | null = nativeAdmin) {
    return appRouter.createCaller({
      db,
      nativeRuntime: runtime,
      user,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  }
  it('starts ownership on the first desk result and retains draft notices and prizes', async () => {
    const planId = await seedNativeDraft(db);
    await caller().eventOps.announce({ planId, message: 'Draft notice', durationSeconds: null });
    await caller().eventOps.savePrize({ planId, title: 'Draft prize' });
    await caller().eventOps.prepare({ planId });
    const [match] = await db
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.eventPlanId, planId));
    await expect(
      caller(null).eventOps.guests.startPoolMatch({
        planId,
        matchId: match!.id,
        stationId: crypto.randomUUID(),
        expectedRevision: 0,
        sessionToken: 'x'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await db.select().from(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toHaveLength(0);
    await caller().eventOps.reportScore({
      matchId: match!.id,
      expectedRevision: 0,
      requestId: 'first-result',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    const state = await runtime.state(planId);
    expect(state.matches.find((m) => m.id === match!.id)!.outcome).toBe('played');
    expect(state.announcements.map((a) => a.message)).toEqual(['Draft notice']);
    expect(state.prizes.map((p) => p.title)).toEqual(['Draft prize']);
    expect(
      await db.select().from(eventAnnouncements).where(eq(eventAnnouncements.eventPlanId, planId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(eventPrizes).where(eq(eventPrizes.eventPlanId, planId)),
    ).toHaveLength(1);
    expect(
      (await db.select().from(eventMatches).where(eq(eventMatches.id, match!.id)))[0]!.outcome,
    ).toBeNull();
    expect(await runtime.replay(planId)).toEqual(state);
  });
  it('pauses an unplayed draw without handing ownership back to SQL', async () => {
    const planId = await seedNativeDraft(db);
    const operator = caller();
    await operator.eventOps.softLockPools({ planId, confirm: true });
    const initialIds = (await runtime.state(planId)).matches.map((m) => m.id);
    await operator.eventOps.unlockPools({ planId, confirm: true });
    expect((await operator.eventOps.overview({ planId })).plan.drawPaused).toBe(true);
    await expect(operator.admin.eventPlanner.unfreezeRoster({ planId })).rejects.toThrow(
      /attendance changes/,
    );
    const [late] = await db.insert(players).values({ canonicalName: 'Paused arrival' }).returning();
    const attendance = {
      planId,
      action: 'add' as const,
      playerId: late!.id,
      division: 'upper' as const,
    };
    const preview = await operator.eventOps.previewAttendance(attendance);
    await operator.eventOps.applyAttendance({
      ...attendance,
      revisionToken: preview.revisionToken,
    });
    const state = await runtime.state(planId);
    expect(state.lifecycle).toBe('unlocked');
    expect(initialIds.every((id) => state.matches.some((m) => m.id === id))).toBe(true);
    await expect(
      operator.eventOps.reportScore({
        matchId: state.matches[0]!.id,
        expectedRevision: 0,
        requestId: 'paused-score',
        score1: 2,
        score2: 0,
        outcome: 'played',
      }),
    ).rejects.toThrow(/relock/i);
    await operator.eventOps.softLockPools({ planId, confirm: true });
    expect((await operator.eventOps.overview({ planId })).plan.drawPaused).toBe(false);
    await expect(
      operator.admin.mergePlayers({
        fromPlayerId: late!.id,
        intoPlayerId: state.entrants[0]!.playerId,
      }),
    ).rejects.toThrow(/active event/);
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
  });
  it('cuts over through normal locking, reads and desk controls while SQL stays frozen', async () => {
    const planId = await seedNativeDraft(db);
    const operator = caller(),
      publicApi = caller(null);
    await operator.eventOps.softLockPools({ planId, confirm: true });
    expect(
      await db.select().from(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toHaveLength(1);
    const stationInput = { planId, name: 'Station 1', requestId: 'create-station' };
    const station = (await operator.eventOps.saveStation(stationInput))[0]!;
    const sequence = (await runtime.state(planId)).sequence;
    expect((await operator.eventOps.saveStation(stationInput))[0]!.id).toBe(station.id);
    expect((await runtime.state(planId)).sequence).toBe(sequence);
    let overview = await operator.eventOps.overview({ planId });
    const match = overview.matches[0]!;
    await operator.eventOps.updateMatch({
      matchId: match.id,
      expectedRevision: match.revision,
      expectedResourceRevision: match.resourceRevision,
      status: 'playing',
      stationId: station.id,
    });
    overview = await operator.eventOps.overview({ planId });
    const playing = overview.matches.find((m) => m.id === match.id)!;
    expect(playing.revision).toBe(match.revision);
    await operator.eventOps.updateLiveScore({
      matchId: match.id,
      expectedRevision: match.revision,
      expectedProgressRevision: playing.progressRevision,
      score1: 1,
      score2: 1,
    });
    await expect(
      operator.eventOps.updateLiveScore({
        matchId: match.id,
        expectedRevision: match.revision,
        expectedProgressRevision: playing.progressRevision,
        score1: 2,
        score2: 1,
      }),
    ).rejects.toThrow(/changed/);
    expect(
      (await publicApi.eventOps.snapshot({ planId })).matches.find((m) => m.id === match.id)!
        .score1,
    ).toBe(1);
    await operator.eventOps.announce({ planId, message: 'Finals soon', durationSeconds: null });
    await operator.eventOps.savePrize({ planId, title: 'Spirit', playerId: match.player1Id });
    const view = await publicApi.eventOps.snapshot({ planId });
    expect(view.announcements[0]!.message).toBe('Finals soon');
    expect(view.prizes[0]!.playerId).toBe(match.player1Id);
    await operator.eventOps.reportScore({
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: 'desk-result',
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    expect(
      (await publicApi.eventOps.snapshot({ planId })).matches.find((m) => m.id === match.id)!
        .status,
    ).toBe('complete');
    expect(
      (await db.select().from(eventMatches).where(eq(eventMatches.id, match.id)))[0]!.status,
    ).toBe('ready');
    await operator.eventOps.deleteStation({ planId, id: station.id });
    expect((await operator.eventOps.overview({ planId })).stations).toHaveLength(0);
    await operator.eventOps.settings({ planId, published: false, playerReports: true });
    expect((await publicApi.eventOps.publicEvents()).some((p) => p.id === planId)).toBe(false);
    await expect(publicApi.eventOps.snapshot({ planId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
  });
  it('reviews an attendee report without replacing the chosen match identity', async () => {
    const planId = await seedNativeDraft(db);
    const operator = caller();
    await operator.eventOps.softLockPools({ planId, confirm: true });
    await operator.eventOps.settings({
      planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    const attendee = caller({
      id: 'native-attendee',
      name: 'Attendee',
      email: 'attendee@example.test',
      role: 'user',
    });
    const before = await runtime.state(planId);
    const match = before.matches[0]!;
    const report = await attendee.eventOps.reportScore({
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: 'attendee-report',
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    expect(report.status).toBe('pending');
    expect(report.id).not.toBe(match.id);
    await operator.eventOps.reviewReport({ reportId: report.id, approve: true });
    const after = await runtime.state(planId);
    expect(after.matches.map((m) => [m.id, m.sourceKey, m.player1Id, m.player2Id])).toEqual(
      before.matches.map((m) => [m.id, m.sourceKey, m.player1Id, m.player2Id]),
    );
    expect(
      (await caller(null).eventOps.snapshot({ planId })).matches.find((m) => m.id === match.id),
    ).toMatchObject({ status: 'complete', score1: 2, score2: 1 });
    expect((await attendee.eventOps.myReports({ planId }))[0]).toMatchObject({
      id: report.id,
      matchId: match.id,
      status: 'approved',
    });
    const next = before.matches[1]!;
    const retryInput = {
      matchId: next.id,
      expectedRevision: next.revision,
      requestId: 'rejected-report',
      score1: 2,
      score2: 1,
      outcome: 'played' as const,
    };
    const rejected = await attendee.eventOps.reportScore(retryInput);
    await operator.eventOps.reviewReport({ reportId: rejected.id, approve: false });
    const replacement = await attendee.eventOps.reportScore({
      ...retryInput,
      requestId: 'new-report',
    });
    expect(
      (await attendee.eventOps.myReports({ planId })).find((r) => r.matchId === next.id),
    ).toMatchObject({ id: replacement.id, status: 'pending' });
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
  });
  it('journals late attendance and guest self-service without guest credentials in the stream', async () => {
    const planId = await seedNativeDraft(db);
    const operator = caller(),
      publicApi = caller(null);
    await operator.eventOps.softLockPools({ planId, confirm: true });
    await operator.eventOps.settings({ planId, published: true, playerReports: false });
    const [late] = await db
      .insert(players)
      .values({ canonicalName: 'Late Arrival', displayName: 'Late' })
      .returning();
    const attendance = {
      planId,
      action: 'add' as const,
      playerId: late!.id,
      division: 'upper' as const,
    };
    const preview = await operator.eventOps.previewAttendance(attendance);
    await operator.eventOps.applyAttendance({
      ...attendance,
      revisionToken: preview.revisionToken,
    });
    expect(
      (await operator.admin.eventPlanner.plan({ planId }))!.entries.some(
        (e) => e.playerId === late!.id,
      ),
    ).toBe(true);
    const station = (await operator.eventOps.saveStation({ planId, name: 'Guest station' }))[0]!;
    let view = await operator.eventOps.overview({ planId });
    const pool = view.poolSchedules.find(
      (p) => p.division === 'upper' && p.poolIndex === preview.poolIndex,
    )!;
    await operator.eventOps.configurePools({
      planId,
      pools: [
        {
          ...pool,
          expectedRevision: pool.revision,
          stationIds: [station.id],
          selfRun: true,
          autoAcceptScores: true,
        },
      ],
    });
    await operator.eventOps.guests.configure({ planId, enabled: true, showOnOverlay: true });
    const invite = (await operator.eventOps.guests.invitation({ planId }))!;
    const session = await publicApi.eventOps.guests.redeem({ planId, token: invite.token });
    const guestView = await publicApi.eventOps.guests.matches({
      planId,
      sessionToken: session.sessionToken,
    });
    const matchId = guestView.stationQueues.find((q) => q.stationId === station.id)!.nextMatchId!;
    const match = guestView.matches.find((m) => m.id === matchId)!;
    const startInput = {
      planId,
      sessionToken: session.sessionToken,
      matchId,
      stationId: station.id,
      expectedRevision: match.revision,
      requestId: 'guest-start',
    };
    await publicApi.eventOps.guests.startPoolMatch(startInput);
    const startedSequence = (await runtime.state(planId)).sequence;
    await publicApi.eventOps.guests.startPoolMatch(startInput);
    expect((await runtime.state(planId)).sequence).toBe(startedSequence);
    await operator.eventOps.updateMatch({
      matchId,
      expectedRevision: match.revision,
      status: 'ready',
      stationId: station.id,
    });
    expect(
      (
        await publicApi.eventOps.guests.startPoolMatch({
          ...startInput,
          requestId: 'guest-resumed',
        })
      ).status,
    ).toBe('playing');
    const submission = {
      planId,
      sessionToken: session.sessionToken,
      matchId,
      expectedRevision: match.revision,
      requestId: 'guest-complete',
      score1: 2,
      score2: 1,
    };
    const first = await publicApi.eventOps.guests.submit(submission);
    expect(first.status).toBe('approved');
    expect(await publicApi.eventOps.guests.submit(submission)).toEqual(first);
    const disputing = await publicApi.eventOps.guests.redeem({ planId, token: invite.token });
    const dispute = await publicApi.eventOps.guests.submit({
      ...submission,
      sessionToken: disputing.sessionToken,
      requestId: 'different-score',
      score1: 1,
      score2: 2,
    });
    expect(dispute).toMatchObject({ isDispute: true, status: 'pending' });
    const confirming = await publicApi.eventOps.guests.redeem({ planId, token: invite.token });
    const agreement = await publicApi.eventOps.guests.submit({
      ...submission,
      sessionToken: confirming.sessionToken,
      requestId: 'official-score',
      expectedRevision: match.revision + 1,
    });
    expect(agreement).toMatchObject({ isDispute: false, status: 'approved' });
    view = await operator.eventOps.overview({ planId });
    expect(view.reports.find((r) => r.id === first.reportId)!.reporterLabel).toBe('Guest');
    const events: unknown[] = [];
    await runtime.app.query({ stream: `native:${planId}` }, (e) => {
      events.push(e);
    });
    expect(JSON.stringify(events)).not.toContain(session.sessionToken);
    expect(JSON.stringify(events)).not.toContain(invite.token);
    await operator.eventOps.guests.rotate({ planId });
    await expect(
      publicApi.eventOps.guests.submit({ ...submission, requestId: 'expired' }),
    ).rejects.toThrow(/guest|unavailable|expired|valid/i);
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
  });
  it('runs pool orders, finals, publication and reviewed replacement through the shipped APIs', async () => {
    const planId = await seedNativeDraft(db);
    const operator = caller();
    await operator.eventOps.softLockPools({ planId, confirm: true });
    for (const m of (await operator.eventOps.overview({ planId })).matches)
      await operator.eventOps.reportScore({
        matchId: m.id,
        expectedRevision: m.revision,
        requestId: m.id,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    const plan = (await operator.admin.eventPlanner.plan({ planId }))!;
    for (const division of plan.divisions)
      await operator.admin.eventPlanner.savePoolPlacements({
        planId,
        division: division.division,
        pools: division.pools.map((p) => ({
          poolIndex: p.poolIndex,
          playerIdsInOrder: p.members.map((m) => m.playerId),
          expectedPlacementRevision: p.placementRevision,
          expectedMatchRevisions: p.matchRevisions,
        })),
      });
    let preview = await operator.eventOps.native.preview({ planId });
    expect(preview.allowed).toBe(true);
    await operator.eventOps.native.generate({ planId, revisionToken: preview.revisionToken });
    preview = await operator.eventOps.native.preview({ planId });
    expect(preview.resetAllowed).toBe(true);
    await operator.eventOps.native.reset({ planId, revisionToken: preview.revisionToken });
    preview = await operator.eventOps.native.preview({ planId });
    await operator.eventOps.native.generate({ planId, revisionToken: preview.revisionToken });
    for (;;) {
      const m = (await operator.eventOps.overview({ planId })).matches.find(
        (m) => m.stage !== 'group' && m.status === 'ready',
      );
      if (!m) break;
      await operator.eventOps.reportScore({
        matchId: m.id,
        expectedRevision: m.revision,
        requestId: m.id,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    }
    await operator.eventOps.native.finalize({ planId });
    expect((await operator.eventOps.overview({ planId })).plan.status).toBe('complete');
    const before = await runtime.state(planId);
    expect(before.publication).not.toBeNull();
    const final = before.matches.find((m) => m.stage === 'main' && m.outcome === 'played')!;
    const correction = {
      planId,
      requestId: 'reviewed-replacement',
      command: {
        kind: 'replaceResult' as const,
        resultId: before.result!.id,
        reason: 'TO reviewed the recorded game count',
        corrections: [
          {
            matchId: final.id,
            expectedRevision: final.revision,
            score1: 3,
            score2: 0,
            outcome: 'played' as const,
          },
        ],
      },
    };
    await operator.eventOps.live.command(correction);
    await runtime.drainReactions();
    await operator.eventOps.live.command(correction);
    const after = await runtime.state(planId);
    expect(after.result!.revision).toBe(2);
    expect(after.matches.map((m) => [m.id, m.player1Id, m.player2Id])).toEqual(
      before.matches.map((m) => [m.id, m.player1Id, m.player2Id]),
    );
    const history = await db.select().from(sets);
    expect(
      history
        .filter((s) => before.publication!.tournamentIds.includes(s.tournamentId))
        .every((s) => s.excludedFromRatings),
    ).toBe(true);
    const originalTournament = (
      await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, before.publication!.tournamentIds[0]!))
    )[0]!;
    const overview = await caller(null).public.eventOverview({
      slug: originalTournament.challongeSlug,
    });
    expect(overview!.brackets.map((b) => b.tournamentId).sort()).toEqual(
      [...after.publication!.tournamentIds].sort(),
    );
    expect(overview!.warnings).toEqual([]);
    expect(overview!.divisions.flatMap((d) => d.players).reduce((sum, p) => sum + p.wins, 0)).toBe(
      after.matches.filter((m) => m.outcome === 'played').length,
    );
    expect(
      (await caller(null).public.recap({ slug: originalTournament.challongeSlug }))!.tournaments,
    ).toHaveLength(4);
    const publicTournaments = await caller(null).public.tournaments();
    expect(publicTournaments.some((t) => before.publication!.tournamentIds.includes(t.id))).toBe(
      false,
    );
    expect(
      history
        .filter((s) => after.publication!.tournamentIds.includes(s.tournamentId))
        .some((s) => s.scoresCsv === '3-0' && !s.excludedFromRatings),
    ).toBe(true);
    await processNativeRatingIntents(db);
    expect((await db.select().from(nativeRatingIntents)).every((i) => i.completedAt)).toBe(true);
    expect(await runtime.replay(planId)).toEqual(after);
    const [survivor] = await db
      .insert(players)
      .values({ canonicalName: 'Canonical result identity' })
      .returning();
    await operator.admin.mergePlayers({
      fromPlayerId: final.player1Id!,
      intoPlayerId: survivor!.id,
    });
    await operator.eventOps.live.command({
      ...correction,
      requestId: 'replacement-after-merge',
      command: {
        ...correction.command,
        resultId: after.result!.id,
        corrections: [
          {
            ...correction.command.corrections[0]!,
            expectedRevision: after.matches.find((m) => m.id === final.id)!.revision,
            score1: 4,
          },
        ],
      },
    });
    const current = await runtime.state(planId);
    const currentSets = (await db.select().from(sets)).filter((s) =>
      current.publication!.tournamentIds.includes(s.tournamentId),
    );
    expect(
      currentSets.some((s) => s.p1PlayerId === survivor!.id || s.p2PlayerId === survivor!.id),
    ).toBe(true);
    expect(
      currentSets.some((s) => s.p1PlayerId === final.player1Id || s.p2PlayerId === final.player1Id),
    ).toBe(false);
  });
  it('automatically imports an existing locked SQL night, retaining results and original audit', async () => {
    const planId = await seedNativeDraft(db);
    await softLockPools(db, nativeAdmin, planId);
    const [match] = await db
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.eventPlanId, planId));
    await reportScore(db, nativeAdmin, {
      matchId: match!.id,
      expectedRevision: match!.revision,
      requestId: 'pre-cutover',
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    await runtime.recover();
    const view = await caller().eventOps.overview({ planId });
    expect(view.matches.find((m) => m.id === match!.id)!.score1).toBe(2);
    expect(view.audit.some((a) => a.matchId === match!.id)).toBe(true);
    expect(
      (await runtime.app.query({ stream: `native:${planId}`, names: ['LegacyStateImportedV1'] }))
        .count,
    ).toBe(1);
    await runtime.recover();
    expect(
      (await runtime.app.query({ stream: `native:${planId}`, names: ['LegacyStateImportedV1'] }))
        .count,
    ).toBe(1);
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
    expect(
      (await db.select().from(eventPlans).where(eq(eventPlans.id, planId)))[0]!.softLockedAt,
    ).not.toBeNull();
    expect(
      (
        await db
          .select()
          .from(eventOperationSettings)
          .where(eq(eventOperationSettings.eventPlanId, planId))
      )[0]!.published,
    ).toBe(true);
  });
  it('imports a completed SQL night without duplicating history or recomputing ratings', async () => {
    const planId = await seedNativeDraft(db);
    await softLockPools(db, nativeAdmin, planId);
    const score = (m: typeof eventMatches.$inferSelect) =>
      reportScore(db, nativeAdmin, {
        matchId: m.id,
        expectedRevision: m.revision,
        requestId: crypto.randomUUID(),
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    for (const m of await db
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.eventPlanId, planId)))
      await score(m);
    const plan = (await getPlan(db, planId))!;
    for (const division of plan.divisions)
      await savePoolPlacements(
        db,
        planId,
        division.division,
        division.pools.map((p) => ({
          poolIndex: p.poolIndex,
          playerIdsInOrder: p.members.map((m) => m.playerId),
          expectedMatchRevisions: p.matchRevisions,
          expectedPlacementRevision: p.placementRevision,
        })),
      );
    const preview = await previewNativeBrackets(db, planId);
    await generateNativeBrackets(db, nativeAdmin, planId, preview.revisionToken);
    for (;;) {
      const next = (
        await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId))
      ).find((m) => m.stage !== 'group' && m.status === 'ready');
      if (!next) break;
      await score(next);
    }
    await finalizeNativeEvent(db, nativeAdmin, planId);
    const count = (await db.select().from(sets)).length;
    await runtime.recover();
    const state = await runtime.state(planId);
    expect(state.lifecycle).toBe('finalized');
    expect(state.publication!.tournamentIds).toHaveLength(4);
    expect(await db.select().from(sets)).toHaveLength(count);
    expect(
      await db
        .select()
        .from(nativeRatingIntents)
        .where(eq(nativeRatingIntents.resultId, state.result!.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(nativeResultPublications)
        .where(eq(nativeResultPublications.eventPlanId, planId)),
    ).toHaveLength(1);
    expect(await runtime.replay(planId)).toEqual(state);
    await caller().admin.mergePlayers({
      fromPlayerId: state.entrants[0]!.playerId,
      intoPlayerId: state.entrants[1]!.playerId,
    });
  });
});
