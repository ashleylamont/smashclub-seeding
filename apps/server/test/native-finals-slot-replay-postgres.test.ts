import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  nativeResultPublications,
  players,
  sets,
  tournamentParticipants,
  tournaments,
} from '@smashclub/db';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { nativeFinalsSlotReplayFixture } from './helpers/nativeFinalsSlotReplay';
import {
  createPostgresNativeRuntime,
  nativeStream,
  type NativeRuntime,
} from '../src/tournament/runtime';
import { loadSinglesHistory } from '../src/recompute/inputs';
import { loadDoublesRatings } from '../src/recompute/doubles';
import { processNativeRatingIntents, publishNativeResult } from '../src/tournament/publication';

let pg: Awaited<ReturnType<typeof postgresCluster>>;
let runtime: NativeRuntime;
let fixture: ReturnType<typeof nativeFinalsSlotReplayFixture>;

beforeAll(async () => {
  pg = await postgresCluster();
  runtime = await createPostgresNativeRuntime(pg.db, pg.connectionString);
  fixture = nativeFinalsSlotReplayFixture(pg, runtime);
});
afterAll(async () => {
  await runtime?.shutdown();
  await pg?.close();
});

describe('reviewed native finals slot replay on PostgreSQL', () => {
  it('records Alice beating Chris and rates both real sets while only the new slot advances', async () => {
    const context = await fixture.prepare();
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
    const oldInput = fixture.score(original, alice);
    const oldReport = await eventOps.reportScore(oldInput);
    await report(sibling, sibling.player1Id!);
    const before = await state();
    const actual = before.matches.find(({ id }) => id === original.id)!;
    const oldRoute = before.matches.find(({ id }) => id === downstream.id)!;
    const side = oldRoute.parent1Id === actual.id ? 'player1Id' : 'player2Id';
    const parent = oldRoute.parent1Id === actual.id ? 'parent1Id' : 'parent2Id';
    expect(oldRoute).toMatchObject({ [side]: alice, status: 'ready', started: false });
    const publicApi = fixture.caller(null);
    await eventOps.guests.configure({ planId, enabled: true, showOnOverlay: false });
    const invitation = await eventOps.guests.invitation({ planId });
    const guest = await publicApi.eventOps.guests.redeem({ planId, token: invitation!.token });
    const guestInput = {
      planId,
      sessionToken: guest.sessionToken,
      ...fixture.score(actual, alice),
    };
    const guestReport = await publicApi.eventOps.guests.submit(guestInput);
    expect(guestReport.status).toBe('approved');

    const approved = await review();
    expect(
      await eventOps.live.previewFinalsSlotReplay({ planId, ...reviewInput, reviewVersion: 2 }),
    ).toEqual(approved);
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
    const otherUser = fixture.caller({ ...nativeAdmin, id: crypto.randomUUID(), role: 'user' });
    const signedInput = fixture.score(actual, alice);
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
    expect(fixture.lowerFacts(changed)).toEqual(fixture.lowerFacts(beforeReplay));
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
    expect(
      (await fixture.caller(null).eventOps.live.snapshot({ planId })).supersededPlayedSets,
    ).toEqual(publicBoard.supersededPlayedSets);
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
    const finalized = await fixture.finish(context, bea, archived.replacementMatchId);
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
    const { state, report, review, send, reviewedCommand, original, alice } = await fixture.prepare(
      {
        consolation: true,
      },
    );
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
});

describe('reciprocal finals routes on PostgreSQL', () => {
  it('atomically swaps championship and untouched consolation entrants with no duplicate route', async () => {
    const context = await fixture.prepare({ consolation: true });
    const {
      planId,
      eventOps,
      state,
      report,
      send,
      review,
      reviewInput,
      reviewedCommand,
      bracket,
      pool,
      original,
      sibling,
      downstream,
      alice,
      bea,
      chris,
    } = context;
    const before = await state();
    const consolation = before.brackets.find(
      (b) => b.division === 'upper' && b.stage === 'consolation',
    )!;
    const consolationRoot = before.matches.find(
      (match) =>
        match.bracketId === consolation.id &&
        [match.player1Qualifier, match.player2Qualifier].some(
          (slot) => slot?.poolId === pool.id && slot.place === 3,
        ),
    )!;
    const consolationSibling = before.matches.find(
      (match) =>
        match.bracketId === consolation.id && match.round === 1 && match.id !== consolationRoot.id,
    )!;
    const consolationFinal = before.matches.find(
      (match) => match.parent1Id === consolationRoot.id || match.parent2Id === consolationRoot.id,
    )!;
    await report(original, alice);
    await report(sibling, sibling.player1Id!);
    await report(consolationSibling, consolationSibling.player1Id!);
    const recorded = await state();
    const v2 = () =>
      eventOps.live.previewFinalsSlotReplay({ planId, ...reviewInput, reviewVersion: 2 });
    const approved = await v2();
    expect(await review()).toMatchObject({
      allowed: false,
      issues: [expect.stringContaining('more than one')],
    });
    expect(approved).toMatchObject({
      allowed: true,
      qualifierChanges: [
        { bracketId: bracket.id, place: 2, beforeEntrantId: alice, afterEntrantId: bea },
        { bracketId: consolation.id, place: 3, beforeEntrantId: bea, afterEntrantId: alice },
      ],
      companion: {
        matchId: consolationRoot.id,
        beforeEntrantId: bea,
        afterEntrantId: alice,
        downstream: [{ id: consolationFinal.id }],
      },
    });
    if (!approved.allowed) throw new Error(approved.issues.join(' '));
    const oldMain = recorded.matches.find(({ id }) => id === original.id)!;
    expect(oldMain).toMatchObject({ winnerId: alice, outcome: 'played' });
    const lower = recorded.matches.find(
      (m) => m.division === 'lower' && m.bracketId && m.status === 'ready',
    )!;
    await report(lower, lower.player1Id!);
    const preApply = await state();
    expect(await v2()).toEqual(approved);
    await expect(send(reviewedCommand(approved.revisionToken))).rejects.toThrow(/more than one/);
    const command = {
      ...reviewedCommand(approved.revisionToken),
      kind: 'replayFinalsRoutesV2' as const,
    };
    const requestId = crypto.randomUUID();
    const result = await send(command, requestId);
    const after = await state();
    expect(after.supersededPlayedSets).toHaveLength(1);
    const archive = after.supersededPlayedSets![0]!;
    expect(archive.match).toEqual(oldMain);
    expect(after.matches.some(({ id }) => id === oldMain.id)).toBe(false);
    const replay = after.matches.find(({ id }) => id === archive.replacementMatchId)!;
    expect([replay.player1Id, replay.player2Id]).toEqual(expect.arrayContaining([bea, chris]));
    const consolationMatch = after.matches.find(({ id }) => id === consolationRoot.id)!;
    const changedSide = consolationRoot.player1Id === bea ? 'player1Id' : 'player2Id';
    expect(consolationMatch).toEqual({
      ...consolationRoot,
      [changedSide]: alice,
      revision: consolationRoot.revision + 1,
      readySince: expect.any(Number),
    });
    expect(after.matches.find(({ id }) => id === consolationFinal.id)).toEqual(
      preApply.matches.find(({ id }) => id === consolationFinal.id),
    );
    for (const [id, expectedBracket] of [
      [alice, consolation.id],
      [bea, bracket.id],
    ]) {
      expect(after.brackets.filter((b) => b.entrantIds.includes(id!)).map((b) => b.id)).toEqual([
        expectedBracket,
      ]);
    }
    expect(fixture.lowerFacts(after)).toEqual(fixture.lowerFacts(preApply));
    expect(after.brackets.find(({ id }) => id === bracket.id)?.strengthSeeding).toEqual(
      bracket.strengthSeeding,
    );
    expect(after.brackets.find(({ id }) => id === consolation.id)?.strengthSeeding).toEqual(
      consolation.strengthSeeding,
    );
    expect((await send(command, requestId)).receipt).toEqual(result.receipt);
    await expect(send({ ...command, reason: 'Different reason' }, requestId)).rejects.toThrow(
      /already used/,
    );
    await expect(report(consolationRoot, bea)).rejects.toThrow(/match changed/i);
    const history = await eventOps.live.history({ planId });
    expect(history.entries[0]).toMatchObject({
      eventName: 'DecisionRecordedV9',
      matchId: replay.id,
      details: {
        finalsReplayCompanion: {
          matchId: consolationRoot.id,
          beforeEntrantId: bea,
          afterEntrantId: alice,
        },
      },
    });

    await report(replay, bea);
    await report(consolationMatch, alice);
    const advanced = await state();
    const championshipFinal = advanced.matches.find(({ id }) => id === downstream.id)!;
    const playedConsolationFinal = advanced.matches.find(({ id }) => id === consolationFinal.id)!;
    expect([championshipFinal.player1Id, championshipFinal.player2Id]).toContain(bea);
    expect([championshipFinal.player1Id, championshipFinal.player2Id]).not.toContain(alice);
    expect([playedConsolationFinal.player1Id, playedConsolationFinal.player2Id]).toContain(alice);
    expect([playedConsolationFinal.player1Id, playedConsolationFinal.player2Id]).not.toContain(bea);
    for (;;) {
      const ready = (await state()).matches.find((match) => match.status === 'ready');
      if (!ready) break;
      await report(ready, ready.player1Id!);
    }
    await eventOps.native.finalize({ planId });
    const published = await state();
    expect(published.result?.supersededPlayedSets).toEqual([archive]);
    const exported = await pg.db
      .select()
      .from(sets)
      .where(inArray(sets.tournamentId, published.publication!.tournamentIds));
    const { engineSets } = await loadSinglesHistory(pg.db);
    for (const match of [oldMain, replay, consolationMatch]) {
      const matching = exported.filter(
        (set) => (set.raw as { eventMatchId?: string }).eventMatchId === match.id,
      );
      expect(matching).toHaveLength(1);
      expect(engineSets.filter((set) => set.id === matching[0]!.id)).toHaveLength(1);
    }
    await pg.pool.query('delete from native_act.events where stream=$1 and name=$2', [
      nativeStream(planId),
      '__snapshot__',
    ]);
    expect(await runtime.replay(planId)).toEqual(published);
  });

  it('reconstructs a V9 doubles replay after a V8 substitution in the same journal', async () => {
    const context = await fixture.prepare({
      doubles: true,
      consolation: true,
      substituteBeforePlay: true,
    });
    const { planId, eventOps, state, report, send, reviewInput, reviewedCommand, original, alice } =
      context;
    await report(original, alice);
    const preview = await eventOps.live.previewFinalsSlotReplay({
      planId,
      ...reviewInput,
      reviewVersion: 2,
    });
    if (!preview.allowed) throw new Error(preview.issues.join(' '));
    await send({ ...reviewedCommand(preview.revisionToken), kind: 'replayFinalsRoutesV2' });
    const saved = await state();
    const { entrantId, memberPlayerIds } = context.substitution!;
    expect(saved.entrants.find(({ id }) => id === entrantId)).toMatchObject({
      memberPlayerIds,
      memberSubstituted: true,
    });
    const history = await eventOps.live.history({ planId, limit: 100 });
    expect(
      history.entries
        .filter(({ eventName }) => ['DecisionRecordedV8', 'DecisionRecordedV9'].includes(eventName))
        .map(({ eventName }) => eventName),
    ).toEqual(['DecisionRecordedV9', 'DecisionRecordedV8']);
    await pg.pool.query('delete from native_act.events where stream=$1 and name=$2', [
      nativeStream(planId),
      '__snapshot__',
    ]);
    const restarted = await createPostgresNativeRuntime(pg.db, pg.connectionString);
    try {
      expect(await restarted.state(planId)).toEqual(saved);
      expect(await restarted.replay(planId)).toEqual(saved);
    } finally {
      await restarted.shutdown();
    }
  });

  it('blocks both updates after a consolation call, hold or report races the reviewed swap', async () => {
    const context = await fixture.prepare({ consolation: true });
    const {
      planId,
      eventOps,
      state,
      report,
      send,
      reviewInput,
      reviewedCommand,
      original,
      pool,
      alice,
    } = context;
    await report(original, alice);
    const mainPlayed = await state();
    const consolationRoot = mainPlayed.matches.find(
      (match) =>
        match.stage === 'consolation' &&
        [match.player1Qualifier, match.player2Qualifier].some(
          (source) => source?.poolId === pool.id && source.place === 3,
        ),
    )!;
    await send({
      kind: 'configureDispatch',
      capacity: 2,
      reservedStationIds: [],
      expectedResourceRevision: mainPlayed.settings.resourceRevision,
    });
    const v2 = () =>
      eventOps.live.previewFinalsSlotReplay({ planId, ...reviewInput, reviewVersion: 2 });
    const reviewCommand = async () => {
      const preview = await v2();
      if (!preview.allowed) throw new Error(preview.issues.join(' '));
      return { ...reviewedCommand(preview.revisionToken), kind: 'replayFinalsRoutesV2' as const };
    };
    const attempt = await reviewCommand();
    await send({
      kind: 'dispatch',
      matchId: consolationRoot.id,
      stationId: null,
      callOnly: true,
      expectedRevision: consolationRoot.revision,
      expectedResourceRevision: (await state()).settings.resourceRevision,
    });
    const called = await state();
    await expect(send(attempt)).rejects.toThrow(/return any untaken call/i);
    expect(await state()).toEqual(called);
    const move = async (status: 'blocked' | 'ready') => {
      const current = await state();
      return send({
        kind: 'matchControl',
        matchId: consolationRoot.id,
        expectedRevision: current.matches.find(({ id }) => id === consolationRoot.id)!.revision,
        expectedResourceRevision: current.settings.resourceRevision,
        status,
        stationId: null,
        reason: status === 'blocked' ? 'Organiser hold' : null,
      });
    };
    await move('ready');
    const afterReturn = await reviewCommand();
    await move('blocked');
    const held = await state();
    await expect(send(afterReturn)).rejects.toThrow(/organiser hold/i);
    expect(await state()).toEqual(held);
    await move('ready');
    await eventOps.settings({
      planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    const afterHold = await reviewCommand();
    const attendee = fixture.caller({ ...nativeAdmin, id: crypto.randomUUID(), role: 'user' });
    const ready = (await state()).matches.find(({ id }) => id === consolationRoot.id)!;
    const pending = await attendee.eventOps.reportScore(fixture.score(ready, ready.player1Id!));
    expect(pending.status).toBe('pending');
    const submitted = await state();
    await expect(send(afterHold)).rejects.toThrow(/consolation route has score report history/i);
    expect(await state()).toEqual(submitted);
    await eventOps.reviewReport({ reportId: pending.id, approve: false });
    const rejected = await state();
    await expect(send(afterHold)).rejects.toThrow(/consolation route has score report history/i);
    expect(await state()).toEqual(rejected);
  });

  it('leaves an already recorded consolation bye and its route for a separate ruling', async () => {
    const {
      planId,
      eventOps,
      state,
      report,
      send,
      reviewInput,
      reviewedCommand,
      original,
      pool,
      alice,
      bea,
    } = await fixture.prepare({ consolation: true, consolationBye: true });
    await report(original, alice);
    const before = await state();
    const bye = before.matches.find(
      (match) =>
        match.stage === 'consolation' &&
        [match.player1Qualifier, match.player2Qualifier].some(
          (slot) => slot?.poolId === pool.id && slot.place === 3,
        ),
    );
    expect(bye).toMatchObject({ status: 'complete', outcome: 'bye', winnerId: bea });
    const blocked = await eventOps.live.previewFinalsSlotReplay({
      planId,
      ...reviewInput,
      reviewVersion: 2,
    });
    expect(blocked).toMatchObject({
      allowed: false,
      issues: [expect.stringContaining('without a bye')],
    });
    await expect(
      send({
        ...reviewedCommand('0'.repeat(64)),
        kind: 'replayFinalsRoutesV2',
      }),
    ).rejects.toThrow(/without a bye/);
    expect(await state()).toEqual(before);
  });
});

describe('single finals replay archives on PostgreSQL', () => {
  it('preserves archived actual play when all active matches in that division are unplayed, and rates both doubles sets', async () => {
    const context = await fixture.prepare({ doubles: true, substituteBeforePlay: true });
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
    const finalized = await fixture.finish(context, bea, archived.replacementMatchId);
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
    } = await fixture.prepare();
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
    const attendee = fixture.caller({ ...nativeAdmin, id: crypto.randomUUID(), role: 'user' });
    const pending = await attendee.eventOps.reportScore(fixture.score(match, match.player1Id!));
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
