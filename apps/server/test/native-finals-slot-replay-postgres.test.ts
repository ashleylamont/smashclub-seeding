import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  eventOperationSettings,
  eventPlans,
  nativeResultPublications,
  players,
  sets,
  tournamentParticipants,
  tournaments,
} from '@smashclub/db';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import {
  createPostgresNativeRuntime,
  nativeStream,
  type NativeRuntime,
} from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { loadSinglesHistory } from '../src/recompute/inputs';
import { loadDoublesRatings } from '../src/recompute/doubles';
import { processNativeRatingIntents, publishNativeResult } from '../src/tournament/publication';
import type { Match, TournamentCommand, TournamentState } from '../src/tournament/schemas';
import type { SessionUser } from '../src/auth';

describe('reviewed native finals slot replay on PostgreSQL', () => {
  let pg: Awaited<ReturnType<typeof postgresCluster>>;
  let runtime: NativeRuntime;

  beforeAll(async () => {
    pg = await postgresCluster();
    runtime = await createPostgresNativeRuntime(pg.db, pg.connectionString);
  });
  afterAll(async () => {
    await runtime?.shutdown();
    await pg?.close();
  });

  function caller(user: SessionUser | null = nativeAdmin) {
    return appRouter.createCaller({
      db: pg.db,
      nativeRuntime: runtime,
      user,
      env: loadEnv({ DATABASE_URL: pg.connectionString, NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(pg.db),
    });
  }

  function score(match: Match, winningEntrant: string, requestId = crypto.randomUUID()) {
    return {
      matchId: match.id,
      expectedRevision: match.revision,
      requestId,
      outcome: 'played' as const,
      score1: winningEntrant === match.player1Id ? 2 : 1,
      score2: winningEntrant === match.player1Id ? 1 : 2,
    };
  }

  async function draftDoubles() {
    const members = await pg.db
      .insert(players)
      .values(
        Array.from({ length: 32 }, (_, i) => ({
          canonicalName: `Replay pair member ${i} ${crypto.randomUUID()}`,
          displayName: `Member ${i}`,
        })),
      )
      .returning();
    const { admin } = caller();
    const { planId } = await admin.eventPlanner.createPlan({
      competitionFormat: 'doubles',
      bracketMode: 'native',
      structure: 'dual_division',
      structureOptions: { roundRobinMeetings: 1, consolation: false },
      name: 'Pair finals replay',
      eventDate: '2026-10-03T00:00:00Z',
      upperTargetSize: 8,
      rows: [],
    });
    for (let i = 0; i < 16; i++)
      await admin.eventPlanner.addDoublesPair({
        planId,
        playerId: members[i * 2]!.id,
        partnerPlayerId: members[i * 2 + 1]!.id,
        teamName: `Pair ${i}`,
      });
    await admin.eventPlanner.freezeRoster({ planId });
    await admin.eventPlanner.generatePools({ planId });
    await pg.db.insert(eventOperationSettings).values({
      eventPlanId: planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    return planId;
  }

  async function substituteLowerPair(planId: string, state: TournamentState) {
    const entrant = state.entrants.find((e) => e.division === 'lower')!;
    const [incoming] = await pg.db
      .insert(players)
      .values({
        canonicalName: 'Mixed journal substitute',
        displayName: 'Mixed substitute',
      })
      .returning();
    const request = {
      planId,
      entrantId: entrant.id,
      outgoingPlayerId: entrant.memberPlayerIds![1]!,
      incomingPlayerId: incoming!.id,
      reason: 'Original lower pair member unavailable before play',
    };
    const { eventOps } = caller();
    const preview = await eventOps.previewDoublesSubstitution(request);
    expect(preview.allowed).toBe(true);
    await eventOps.applyDoublesSubstitution({
      ...request,
      requestId: 'substitution-before-finals-replay',
      revisionToken: preview.revisionToken,
    });
    return {
      entrantId: entrant.id,
      memberPlayerIds: [entrant.memberPlayerIds![0]!, incoming!.id],
    };
  }

  async function prepare({
    consolation = false,
    doubles = false,
    substituteBeforePlay = false,
  } = {}) {
    const planId = doubles ? await draftDoubles() : await seedNativeDraft(pg.db);
    if (!doubles)
      await pg.db
        .update(eventPlans)
        .set({
          structure: 'dual_division',
          structureOptions: { roundRobinMeetings: 1, consolation },
        })
        .where(eq(eventPlans.id, planId));
    const { eventOps } = caller();
    const state = () => runtime.state(planId);
    const send = (command: TournamentCommand, requestId = crypto.randomUUID()) =>
      eventOps.live.command({ planId, requestId, command });
    const report = (match: Match, winner: string) => eventOps.reportScore(score(match, winner));
    await eventOps.softLockPools({ planId, confirm: true });
    const substitution = substituteBeforePlay
      ? await substituteLowerPair(planId, await state())
      : null;
    const initial = await state();
    for (const match of initial.matches) {
      const pool = initial.pools.find(({ id }) => id === match.poolId)!;
      await report(
        match,
        pool.entrantIds.find((id) => [match.player1Id, match.player2Id].includes(id))!,
      );
    }
    const drawArgs = { planId, seedPolicy: 'pool_place_whr_v1' as const };
    const preview = await eventOps.native.preview(drawArgs);
    await eventOps.native.generate({
      ...drawArgs,
      revisionToken: preview.revisionToken,
      requestId: crypto.randomUUID(),
    });
    const drawn = await state();
    const bracket = drawn.brackets.find((b) => b.division === 'upper' && b.stage === 'main')!;
    const place = bracket.qualifierSlots!.find(({ place }) => place === 2)!;
    const pool = drawn.pools.find(({ id }) => id === place.poolId)!;
    expect(pool.order).toHaveLength(4);
    const [first, alice, bea, fourth] = pool.order!;
    const original = drawn.matches.find(
      (m) =>
        m.bracketId === bracket.id && m.round === 1 && [m.player1Id, m.player2Id].includes(alice!),
    )!;
    const chris = original.player1Id === alice ? original.player2Id! : original.player1Id!;
    const sibling = drawn.matches.find(
      (m) => m.bracketId === bracket.id && m.round === 1 && m.id !== original.id,
    )!;
    const downstream = drawn.matches.find(
      (m) => m.parent1Id === original.id || m.parent2Id === original.id,
    )!;
    const source = drawn.matches.find(
      (m) =>
        m.poolId === pool.id &&
        [m.player1Id, m.player2Id].includes(alice!) &&
        [m.player1Id, m.player2Id].includes(bea!),
    )!;
    const { requestId: _, outcome: __, ...reviewInput } = score(source, bea!);
    const review = () => eventOps.live.previewFinalsSlotReplay({ planId, ...reviewInput });
    const reviewedCommand = (revisionToken: string) => ({
      kind: 'replayFinalsSlotV1' as const,
      ...reviewInput,
      revisionToken,
      reason: 'Checked score sheet with both entrants',
    });
    return {
      planId,
      eventOps,
      state,
      send,
      report,
      review,
      reviewedCommand,
      original,
      sibling,
      downstream,
      source,
      pool,
      bracket,
      alice: alice!,
      bea: bea!,
      chris,
      first,
      fourth,
      reviewInput,
      substitution,
    };
  }

  const lowerFacts = (state: TournamentState) => {
    const matches = state.matches.filter((m) => m.division === 'lower');
    return {
      matches,
      pools: state.pools.filter((p) => p.division === 'lower'),
      brackets: state.brackets.filter((b) => b.division === 'lower'),
      reports: state.reports.filter((r) => matches.some((m) => m.id === r.matchId)),
      stations: state.stations,
    };
  };

  async function finish(
    context: Awaited<ReturnType<typeof prepare>>,
    preferredWinner: string,
    replacementMatchId: string,
  ) {
    const replacement = (await context.state()).matches.find(
      ({ id }) => id === replacementMatchId,
    )!;
    await context.report(replacement, preferredWinner);
    const downstream = (await context.state()).matches.find(
      ({ id }) => id === context.downstream.id,
    )!;
    expect([downstream.player1Id, downstream.player2Id]).toContain(preferredWinner);
    expect([downstream.player1Id, downstream.player2Id]).not.toContain(context.alice);
    for (;;) {
      const ready = (await context.state()).matches.find((m) => m.status === 'ready');
      if (!ready) break;
      await context.report(ready, ready.player1Id!);
    }
    await context.eventOps.native.finalize({ planId: context.planId });
    return context.state();
  }

  it('records Alice beating Chris and rates both real sets while only the new slot advances', async () => {
    const context = await prepare();
    const {
      planId,
      eventOps,
      state,
      send,
      report,
      review,
      reviewedCommand,
      original,
      sibling,
      downstream,
      pool,
      bracket,
      alice,
      bea,
      chris,
      first,
      fourth,
      reviewInput,
    } = context;
    for (const [id, displayName] of [
      [alice, 'Alice'],
      [bea, 'Bea'],
      [chris, 'Chris'],
    ] as const)
      await pg.db.update(players).set({ displayName }).where(eq(players.id, id));
    const lower = (await state()).matches.find(
      (m) => m.division === 'lower' && m.bracketId && m.status === 'ready',
    )!;
    await report(lower, lower.player1Id!);
    const oldInput = score(original, alice);
    const oldReport = await eventOps.reportScore(oldInput);
    await report(sibling, sibling.player1Id!);
    const before = await state();
    const actual = before.matches.find(({ id }) => id === original.id)!;
    const oldRoute = before.matches.find(({ id }) => id === downstream.id)!;
    const side = oldRoute.parent1Id === actual.id ? 'player1Id' : 'player2Id';
    const parent = oldRoute.parent1Id === actual.id ? 'parent1Id' : 'parent2Id';
    expect(oldRoute).toMatchObject({ [side]: alice, status: 'ready', started: false });
    const publicApi = caller(null);
    await eventOps.guests.configure({ planId, enabled: true, showOnOverlay: false });
    const invitation = await eventOps.guests.invitation({ planId });
    const guest = await publicApi.eventOps.guests.redeem({ planId, token: invitation!.token });
    const guestInput = { planId, sessionToken: guest.sessionToken, ...score(actual, alice) };
    const guestReport = await publicApi.eventOps.guests.submit(guestInput);
    expect(guestReport.status).toBe('approved');

    const approved = await review();
    expect(approved).toMatchObject({
      allowed: true,
      qualifierChanges: [
        { bracketId: bracket.id, place: 2, beforeEntrantId: alice, afterEntrantId: bea },
      ],
      replay:
        original.player1Id === alice
          ? { player1Id: bea, player2Id: chris }
          : { player1Id: chris, player2Id: bea },
      downstream: [{ id: oldRoute.id }],
    });
    if (!approved.allowed) throw new Error(approved.issues.join(' '));
    const otherUser = caller({ ...nativeAdmin, id: crypto.randomUUID(), role: 'user' });
    const signedInput = score(actual, alice);
    const signedReport = await otherUser.eventOps.reportScore(signedInput);
    expect(signedReport.status).toBe('approved');
    await expect(
      otherUser.eventOps.live.previewFinalsSlotReplay({ planId, ...reviewInput }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      otherUser.eventOps.live.command({
        planId,
        requestId: crypto.randomUUID(),
        command: reviewedCommand(approved.revisionToken),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await send({
      kind: 'configureDispatch',
      capacity: 2,
      reservedStationIds: [],
      expectedResourceRevision: before.settings.resourceRevision,
    });
    const move = async (status: 'blocked' | 'ready', reason: string | null) =>
      send({
        kind: 'matchControl',
        matchId: oldRoute.id,
        expectedRevision: oldRoute.revision,
        expectedResourceRevision: (await state()).settings.resourceRevision,
        status,
        stationId: null,
        reason,
      });
    const afterResources = await review();
    if (!afterResources.allowed) throw new Error(afterResources.issues.join(' '));
    expect(afterResources.revisionToken).not.toBe(approved.revisionToken);
    await expect(send(reviewedCommand(approved.revisionToken))).rejects.toThrow(/evidence changed/);
    await send({
      kind: 'station',
      id: crypto.randomUUID(),
      name: 'Unrelated stage',
      expectedResourceRevision: (await state()).settings.resourceRevision,
    });
    expect(await review()).toMatchObject({
      allowed: true,
      revisionToken: afterResources.revisionToken,
    });
    await move('blocked', 'TO hold for stage');
    expect(await review()).toMatchObject({
      allowed: false,
      issues: [expect.stringContaining('organiser hold')],
    });
    await expect(send(reviewedCommand(approved.revisionToken))).rejects.toThrow(/organiser hold/);
    await move('ready', null);
    const ready = await review();
    if (!ready.allowed) throw new Error(ready.issues.join(' '));

    await send({
      kind: 'dispatch',
      matchId: oldRoute.id,
      stationId: null,
      callOnly: true,
      expectedRevision: oldRoute.revision,
      expectedResourceRevision: (await state()).settings.resourceRevision,
    });
    const called = await state();
    await expect(send(reviewedCommand(ready.revisionToken))).rejects.toThrow(
      /downstream pairing has already been called/,
    );
    expect(await state()).toEqual(called);
    await move('ready', null);
    await send({
      kind: 'queueMove',
      matchId: oldRoute.id,
      beforeMatchId: null,
      expectedQueueRevision: (await state()).settings.queueRevision ?? 0,
    });
    const returnedDesk = await eventOps.live.dispatchDesk({ planId });
    const fresh = await review();
    if (!fresh.allowed) throw new Error(fresh.issues.join(' '));

    const beforeReplay = await state();
    const requestId = crypto.randomUUID();
    const input = reviewedCommand(fresh.revisionToken);
    const firstReceipt = await send(input, requestId);
    const changed = await state();
    expect(changed.supersededPlayedSets).toHaveLength(1);
    const archived = changed.supersededPlayedSets![0]!;
    expect(archived.match).toEqual(actual);
    expect(archived.replacementMatchId).not.toBe(actual.id);
    expect(changed.matches.some(({ id }) => id === actual.id)).toBe(false);
    expect(changed.matches.find(({ id }) => id === archived.replacementMatchId)).toMatchObject({
      ...fresh.replay,
      score1: null,
      score2: null,
      status: 'ready',
      revision: 0,
      started: false,
    });
    const replacementDesk = await eventOps.live.dispatchDesk({ planId });
    expect(returnedDesk.queue.find(({ matchId }) => matchId === oldRoute.id)).toMatchObject({
      state: 'ready',
      reason: 'TO order',
    });
    expect(
      replacementDesk.queue.find(({ matchId }) => matchId === archived.replacementMatchId),
    ).toMatchObject({ state: 'ready', reason: 'Waiting time, then feeder matches' });
    expect(replacementDesk.queue.find(({ matchId }) => matchId === oldRoute.id)).toMatchObject({
      state: 'blocked',
    });
    expect(changed.settings.queueOrder).toEqual(
      beforeReplay.settings.queueOrder!.filter((id) => id !== oldRoute.id),
    );
    expect(changed.settings.queueRevision).toBe(beforeReplay.settings.queueRevision! + 1);
    expect(changed.matches.find(({ id }) => id === oldRoute.id)).toMatchObject({
      [side]: null,
      [parent]: archived.replacementMatchId,
      status: 'blocked',
      revision: oldRoute.revision + 1,
    });
    expect(changed.pools.find(({ id }) => id === pool.id)?.order).toEqual([
      first,
      bea,
      alice,
      fourth,
    ]);
    expect(changed.brackets.find(({ id }) => id === bracket.id)?.strengthSeeding).toEqual(
      bracket.strengthSeeding,
    );
    expect(changed.matches.find(({ id }) => id === context.source.id)?.completedAt).toBe(
      context.source.completedAt,
    );
    expect(lowerFacts(changed)).toEqual(lowerFacts(beforeReplay));
    expect(changed.reports.slice(0, beforeReplay.reports.length)).toEqual(beforeReplay.reports);
    expect((await send(input, requestId)).receipt).toEqual(firstReceipt.receipt);
    await expect(send({ ...input, reason: 'Different reason' }, requestId)).rejects.toThrow(
      /already used/,
    );
    expect(await state()).toEqual(changed);

    expect(await eventOps.reportScore(oldInput)).toEqual(oldReport);
    await expect(
      eventOps.reportScore({ ...oldInput, requestId: crypto.randomUUID() }),
    ).rejects.toThrow(/archived/);
    expect(await eventOps.reviewReport({ reportId: oldReport.id, approve: false })).toEqual(
      oldReport,
    );
    expect(await otherUser.eventOps.reportScore(signedInput)).toEqual(signedReport);
    await expect(
      otherUser.eventOps.reportScore({ ...signedInput, requestId: crypto.randomUUID() }),
    ).rejects.toThrow(/archived/);
    expect(await publicApi.eventOps.guests.submit(guestInput)).toEqual(guestReport);
    await expect(
      publicApi.eventOps.guests.submit({ ...guestInput, requestId: crypto.randomUUID() }),
    ).rejects.toThrow(/Match not found/);
    const anotherGuest = await publicApi.eventOps.guests.redeem({
      planId,
      token: invitation!.token,
    });
    await expect(
      publicApi.eventOps.guests.submit({ ...guestInput, sessionToken: anotherGuest.sessionToken }),
    ).rejects.toThrow(/Match not found/);
    const guestBoard = await publicApi.eventOps.guests.matches({
      planId,
      sessionToken: guest.sessionToken,
    });
    expect(guestBoard.reports.map(({ id }) => id)).toEqual([guestReport.reportId]);
    const publicBoard = await publicApi.eventOps.snapshot({ planId });
    expect(publicBoard.supersededPlayedSets).toEqual([
      expect.objectContaining({
        matchId: actual.id,
        replacementMatchId: archived.replacementMatchId,
        score1: actual.score1,
        score2: actual.score2,
        advancementDisposition: 'superseded',
      }),
    ]);
    expect(publicBoard.matches.some(({ id }) => id === actual.id)).toBe(false);
    const publicArchive = publicBoard.supersededPlayedSets![0]!;
    expect([publicArchive.player1Name, publicArchive.player2Name].sort()).toEqual([
      'Alice',
      'Chris',
    ]);
    expect(publicArchive).not.toHaveProperty('sourcePoolMatchId');
    expect(publicArchive).not.toHaveProperty('reason');
    expect((await caller(null).eventOps.live.snapshot({ planId })).supersededPlayedSets).toEqual(
      publicBoard.supersededPlayedSets,
    );
    const history = await eventOps.live.history({ planId });
    expect(history.entries[0]).toMatchObject({
      eventName: 'DecisionRecordedV7',
      title: 'Finals replay scheduled',
      matchId: archived.replacementMatchId,
      summary: expect.stringContaining('superseded advancement'),
    });

    expect(history.entries.filter(({ matchId }) => matchId === actual.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'guest',
          summary: expect.stringMatching(/Alice.*Chris|Chris.*Alice/),
          details: expect.objectContaining({ command: expect.objectContaining({ kind: 'score' }) }),
        }),
      ]),
    );
    const finalized = await finish(context, bea, archived.replacementMatchId);
    expect(finalized.result!.supersededPlayedSets).toEqual([archived]);
    const rows = await pg.db
      .select()
      .from(sets)
      .where(inArray(sets.tournamentId, finalized.publication!.tournamentIds));
    const exported = (matchId: string) =>
      rows.filter((row) => (row.raw as { eventMatchId?: string }).eventMatchId === matchId);
    const [oldSet] = exported(actual.id),
      [newSet] = exported(archived.replacementMatchId);
    expect(exported(actual.id)).toHaveLength(1);
    expect(exported(archived.replacementMatchId)).toHaveLength(1);
    expect(oldSet).toMatchObject({
      p1PlayerId: actual.player1Id,
      p2PlayerId: actual.player2Id,
      winner: actual.player1Id === alice ? 1 : 2,
      scoresCsv: `${actual.score1}-${actual.score2}`,
      completedAt: new Date(actual.completedAt!),
      excludedFromRatings: false,
      raw: {
        advancementDisposition: 'superseded',
        replacementMatchId: archived.replacementMatchId,
      },
    });
    expect(newSet).toMatchObject({
      p1PlayerId: fresh.replay.player1Id,
      p2PlayerId: fresh.replay.player2Id,
      excludedFromRatings: false,
    });
    expect(oldSet!.identifier).toContain('Superseded advancement');
    const participants = await pg.db
      .select()
      .from(tournamentParticipants)
      .where(eq(tournamentParticipants.tournamentId, oldSet!.tournamentId));
    expect(participants.find((p) => p.playerId === alice)?.finalRank).toBeNull();
    const [publishedTournament] = await pg.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, oldSet!.tournamentId));
    const slug = publishedTournament!.challongeSlug;
    const publicTournament = await publicApi.public.tournament({ slug });
    expect(publicTournament?.sets.find(({ id }) => id === oldSet!.id)).toMatchObject({
      advancementDisposition: 'superseded',
      identifier: expect.stringContaining('Superseded advancement'),
      scoresCsv: `${actual.score1}-${actual.score2}`,
    });
    const publicOverview = await publicApi.public.eventOverview({ slug });
    const publicBracket = publicOverview!.brackets.find(
      ({ tournamentId }) => tournamentId === oldSet!.tournamentId,
    )!;
    expect(publicBracket).toMatchObject({
      placeSource: 'reported',
      finalFieldSize: bracket.entrantIds.length,
    });
    expect(publicBracket.players.find(({ playerId }) => playerId === alice)).toMatchObject({
      place: null,
      inFinalStage: false,
      bracketWins: 0,
      bracketLosses: 0,
    });
    const { engineSets } = await loadSinglesHistory(pg.db);
    for (const set of [oldSet!, newSet!])
      expect(engineSets.filter(({ id }) => id === set.id)).toHaveLength(1);
    expect(await publishNativeResult(pg.db, finalized.result!)).toEqual(finalized.publication);
    const publications = await pg.db
      .select()
      .from(nativeResultPublications)
      .where(eq(nativeResultPublications.eventPlanId, planId));
    expect(publications).toHaveLength(1);

    await processNativeRatingIntents(pg.db);
    await pg.pool.query('delete from native_act.events where stream=$1 and name=$2', [
      nativeStream(planId),
      '__snapshot__',
    ]);
    expect(await runtime.replay(planId)).toEqual(finalized);
    const restarted = await createPostgresNativeRuntime(pg.db, pg.connectionString);
    try {
      expect(await restarted.state(planId)).toEqual(finalized);
      expect((await restarted.ratingStatus(planId)).every((intent) => intent.completedAt)).toBe(
        true,
      );
    } finally {
      await restarted.shutdown();
    }
  });

  it('refuses both changed slots with default consolation, leaving actual results intact', async () => {
    const { state, report, review, send, reviewedCommand, original, alice } = await prepare({
      consolation: true,
    });
    await report(original, alice);
    const before = await state();
    expect(await review()).toMatchObject({
      allowed: false,
      issues: [expect.stringContaining('more than one')],
      qualifierChanges: [
        { stage: 'main', place: 2 },
        { stage: 'consolation', place: 3 },
      ],
    });
    await expect(send(reviewedCommand('0'.repeat(64)))).rejects.toThrow(/more than one/);
    expect(await state()).toEqual(before);
  });

  it('preserves archived actual play when all active matches in that division are unplayed, and rates both doubles sets', async () => {
    const context = await prepare({ doubles: true, substituteBeforePlay: true });
    const {
      planId,
      eventOps,
      state,
      send,
      report,
      review,
      reviewedCommand,
      original,
      sibling,
      alice,
      bea,
      chris,
    } = context;
    await report(original, alice);
    const approved = await review();
    if (!approved.allowed) throw new Error(approved.issues.join(' '));
    await send(reviewedCommand(approved.revisionToken));
    const live = await state();
    const archived = live.supersededPlayedSets![0]!;
    expect(live.matches.some((m) => m.bracketId && m.outcome === 'played')).toBe(false);
    const preview = await eventOps.native.preview({ planId, seedPolicy: 'pool_place_whr_v1' });
    expect(preview.resetIssues).toContain('Finals have actual play and cannot be reset.');
    if (!('divisionResets' in preview)) throw new Error('Combined finals preview required.');
    const upper = preview.divisionResets.find(({ scope }) => scope.division === 'upper')!;
    expect(upper.resetAllowed).toBe(false);
    await expect(
      eventOps.native.reset({
        planId,
        scope: upper.scope,
        revisionToken: upper.revisionToken,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/actual play/);
    expect(await state()).toEqual(live);

    await report(sibling, sibling.player1Id!);
    const finalized = await finish(context, bea, archived.replacementMatchId);
    const chrisTeam = finalized.entrants.find(({ playerId }) => playerId === chris)!
      .memberPlayerIds! as [string, string];
    const evidenceCount = finalized.matches.filter(
      (m) => m.outcome === 'played' && [m.player1Id, m.player2Id].includes(chris),
    ).length;
    const rating = await loadDoublesRatings(pg.db, Date.parse('2026-10-04'));
    expect(rating.evidence(chrisTeam)).toEqual({ playedSets: evidenceCount + 1, eventDays: 1 });
    expect(rating.provenance.sourceResultIds).toContain(finalized.result!.id);
    expect(await runtime.replay(planId)).toEqual(finalized);
    const { entrantId, memberPlayerIds } = context.substitution!;
    expect(finalized.result!.entrants.find((e) => e.id === entrantId)).toMatchObject({
      memberPlayerIds,
      memberSubstituted: true,
    });
    const journal = await eventOps.live.history({ planId, limit: 100 });
    expect(
      journal.entries
        .filter(({ eventName }) => ['DecisionRecordedV7', 'DecisionRecordedV8'].includes(eventName))
        .map(({ eventName }) => eventName),
    ).toEqual(['DecisionRecordedV7', 'DecisionRecordedV8']);
    const restarted = await createPostgresNativeRuntime(pg.db, pg.connectionString);
    try {
      expect(await restarted.state(planId)).toEqual(finalized);
      expect(await restarted.replay(planId)).toEqual(finalized);
    } finally {
      await restarted.shutdown();
    }
  });

  it('keeps a downstream report as a blocker after the report is rejected', async () => {
    const {
      planId,
      original,
      sibling,
      downstream,
      report,
      state,
      review,
      reviewedCommand,
      send,
      eventOps,
    } = await prepare();
    await report(original, original.player1Id!);
    await report(sibling, sibling.player1Id!);
    const match = (await state()).matches.find(({ id }) => id === downstream.id)!;
    expect(match.status).toBe('ready');
    await eventOps.settings({
      planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    const preview = await review();
    if (!preview.allowed) throw new Error(preview.issues.join(' '));
    const attendee = caller({ ...nativeAdmin, id: crypto.randomUUID(), role: 'user' });
    const pending = await attendee.eventOps.reportScore(score(match, match.player1Id!));
    expect(pending.status).toBe('pending');
    const command = reviewedCommand(preview.revisionToken);
    await expect(send(command)).rejects.toThrow(/downstream pairing with report history/);
    await eventOps.reviewReport({ reportId: pending.id, approve: false });
    const rejected = await state();
    expect(rejected.reports.find(({ id }) => id === pending.id)?.status).toBe('rejected');
    await expect(send(command)).rejects.toThrow(/downstream pairing with report history/);
    expect(await state()).toEqual(rejected);
  });
});
