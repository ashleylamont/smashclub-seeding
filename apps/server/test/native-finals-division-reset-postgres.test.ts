import { afterAll, beforeAll, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { nativeEventHistory } from '../src/tournament/history';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import type { TournamentCommand, TournamentState } from '../src/tournament/schemas';

let cluster: Awaited<ReturnType<typeof postgresCluster>>;
let store: PostgresStore;
let live: NativeRuntime | undefined;
beforeAll(async () => {
  cluster = await postgresCluster();
  store = new PostgresStore({
    connectionString: cluster.connectionString,
    schema: 'native_act',
    table: 'events',
  });
  await store.seed();
}, 30_000);
afterAll(async () => {
  await live?.shutdown();
  await cluster?.close();
});

it('removes and redraws only the reviewed unplayed division after the other division starts', async () => {
  const planId = await seedNativeDraft(cluster.db);
  const runtime = createNativeRuntime(cluster.db, store);
  live = runtime;
  const context = {
    db: cluster.db,
    nativeRuntime: runtime,
    user: nativeAdmin,
    env: loadEnv({ DATABASE_URL: cluster.connectionString, NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(cluster.db),
  };
  const { eventOps } = appRouter.createCaller(context);
  const state = () => runtime.state(planId);
  const send = (command: TournamentCommand) =>
    runtime.command(nativeAdmin, planId, crypto.randomUUID(), command);
  const report = (match: TournamentState['matches'][number], score1: number, score2: number) =>
    eventOps.reportScore({
      matchId: match.id,
      expectedRevision: match.revision,
      outcome: 'played',
      score1,
      score2,
      requestId: crypto.randomUUID(),
    });
  const args = { planId, seedPolicy: 'pool_place_whr_v1' as const };
  const review = async () => {
    const preview = await eventOps.native.preview(args);
    if (!('divisionResets' in preview)) throw new Error('Combined finals preview required.');
    return {
      preview,
      upper: preview.divisionResets.find(({ scope }) => scope.division === 'upper')!,
      lower: preview.divisionResets.find(({ scope }) => scope.division === 'lower')!,
    };
  };
  await eventOps.softLockPools({ planId, confirm: true });
  const stationId = crypto.randomUUID();
  await send({
    kind: 'station',
    id: stationId,
    name: 'Lower stream',
    expectedResourceRevision: (await state()).settings.resourceRevision,
  });
  await send({
    kind: 'configureDispatch',
    capacity: 2,
    reservedStationIds: [stationId],
    expectedResourceRevision: (await state()).settings.resourceRevision,
  });
  for (const pool of (await state()).pools) {
    for (const match of (await state()).matches.filter(({ poolId }) => poolId === pool.id)) {
      const first =
        pool.entrantIds.indexOf(match.player1Id!) < pool.entrantIds.indexOf(match.player2Id!);
      await report(match, first ? 2 : 0, first ? 0 : 2);
    }
  }
  const create = (revisionToken: string) =>
    eventOps.native.generate({ ...args, revisionToken, requestId: crypto.randomUUID() });
  await create((await review()).preview.revisionToken);
  const originalPreview = (await review()).preview;
  expect(originalPreview.resetBracketIds).toEqual(
    (await state()).brackets.map(({ id }) => id).sort(),
  );
  const originalInput = {
    planId,
    revisionToken: originalPreview.resetRevisionToken,
    requestId: 'ignored on the existing unscoped API',
  };
  expect(await eventOps.native.reset(originalInput)).toEqual({ removed: 4 });
  await expect(eventOps.native.reset(originalInput)).rejects.toThrow(/changed since the preview/);
  await create((await review()).preview.revisionToken);

  const drawn = await state();
  const replacementPreview = (await review()).preview;
  expect(replacementPreview.resetAllowed).toBe(true);
  expect(replacementPreview.resetBracketIds).toEqual(drawn.brackets.map(({ id }) => id).sort());
  expect(
    replacementPreview.resetBracketIds.some((id) => originalPreview.resetBracketIds.includes(id)),
  ).toBe(false);
  await expect(eventOps.native.reset(originalInput)).rejects.toThrow(/changed since the preview/);
  expect(await state()).toEqual(drawn);

  const readyFinals = (division: 'upper' | 'lower') =>
    drawn.matches.filter((m) => m.division === division && m.bracketId && m.status === 'ready');
  const [upperCall] = readyFinals('upper');
  const [lowerPlayed, lowerCall] = readyFinals('lower');
  await send({
    kind: 'queueMove',
    matchId: upperCall!.id,
    beforeMatchId: lowerPlayed!.id,
    expectedQueueRevision: drawn.settings.queueRevision ?? 0,
  });
  const beforeCalls = await review();
  expect(beforeCalls.upper.scope.bracketIds).toHaveLength(2);
  expect(beforeCalls.lower.scope.bracketIds).toHaveLength(2);
  const call = async (match: TournamentState['matches'][number], stationId: string | null) =>
    send({
      kind: 'dispatch',
      matchId: match.id,
      stationId,
      callOnly: true,
      expectedRevision: match.revision,
      expectedResourceRevision: (await state()).settings.resourceRevision,
    });
  await call(upperCall!, null);
  await report(lowerPlayed!, 2, 1);
  await call(lowerCall!, stationId);
  const blocked = await review();
  expect(blocked.upper.resetAllowed).toBe(false);
  expect(blocked.upper.resetCallMatchIds).toEqual([upperCall!.id]);
  expect(blocked.lower.resetIssues).toContain('Finals have actual play and cannot be reset.');
  expect(blocked.lower.resetIssues).toContain('Finals have report history.');
  expect(blocked.lower.resetCallMatchIds).toEqual([]);
  const request = (
    { scope, revisionToken }: typeof blocked.upper,
    requestId = crypto.randomUUID(),
  ) => ({ planId, scope, revisionToken, requestId });
  const remove = (input: ReturnType<typeof request>) => eventOps.native.reset(input);
  await expect(remove(request(beforeCalls.upper))).rejects.toThrow(/changed since the preview/);
  await expect(remove(request(blocked.upper))).rejects.toThrow(/Return untaken finals calls/);
  await expect(remove(request(blocked.lower))).rejects.toThrow(/actual play/);
  await expect(
    eventOps.native.reset({ planId, revisionToken: blocked.preview.resetRevisionToken }),
  ).rejects.toThrow(/actual play/);

  const called = await state();
  await send({
    kind: 'matchControl',
    matchId: upperCall!.id,
    status: 'ready',
    stationId: null,
    reason: null,
    expectedRevision: called.matches.find(({ id }) => id === upperCall!.id)!.revision,
    expectedResourceRevision: called.settings.resourceRevision,
  });
  const fresh = await review();
  expect(fresh.upper.resetAllowed).toBe(true);
  expect(fresh.lower.resetAllowed).toBe(false);
  expect(fresh.preview.resetAllowed).toBe(false);
  await expect(remove(request(blocked.upper))).rejects.toThrow(/changed since the preview/);
  const input = request(fresh.upper);
  // @ts-expect-error Scoped clients must send a request identifier.
  const missingRequestId = eventOps.native.reset({ ...input, requestId: undefined });
  await expect(missingRequestId).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  const wrongBrackets = {
    ...input,
    scope: { ...input.scope, bracketIds: fresh.lower.scope.bracketIds },
  };
  await expect(remove(wrongBrackets)).rejects.toThrow(/changed since the preview/);
  for (const bracketIds of [
    input.scope.bracketIds.slice(0, 1),
    input.scope.bracketIds.toReversed(),
  ])
    await expect(remove({ ...input, scope: { ...input.scope, bracketIds } })).rejects.toThrow(
      /changed since the preview/,
    );
  const otherUser = appRouter.createCaller({
    ...context,
    user: { ...nativeAdmin, id: crypto.randomUUID(), role: 'user' },
  });
  await expect(otherUser.eventOps.native.reset(input)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });

  const frozen = await state();
  const lowerFacts = (snapshot: TournamentState) => {
    const matches = snapshot.matches.filter((m) => m.division === 'lower');
    return {
      matches,
      brackets: snapshot.brackets.filter((b) => b.division === 'lower'),
      pools: snapshot.pools.filter((p) => p.division === 'lower'),
      reports: snapshot.reports.filter((r) => matches.some((m) => m.id === r.matchId)),
      stations: snapshot.stations,
    };
  };
  expect(lowerFacts(frozen).matches).toContainEqual(
    expect.objectContaining({ id: lowerCall!.id, stationId, status: 'playing', started: false }),
  );
  // An independent Lower result changes the global token but leaves the Upper
  // review valid. Keep a second Lower call assigned to its station.
  const lowerOther = readyFinals('lower').find(
    (m) => m.id !== lowerPlayed!.id && m.id !== lowerCall!.id,
  )!;
  await report(lowerOther, 2, 1);
  expect((await review()).upper.revisionToken).toBe(fresh.upper.revisionToken);
  const before = await state();
  expect(await remove(input)).toEqual({ removed: 2 });
  const removed = await state();
  expect(lowerFacts(removed)).toEqual(lowerFacts(before));
  expect(removed.reports).toEqual(before.reports);
  expect(removed.brackets.some((b) => b.division === 'upper')).toBe(false);
  expect(removed.matches.filter((m) => m.division === 'upper')).toEqual(
    before.matches.filter((m) => m.division === 'upper' && !m.bracketId),
  );
  for (const pool of before.pools.filter((p) => p.division === 'upper')) {
    const { qualifierRoster, ...unfrozen } = pool;
    expect(qualifierRoster).toBeDefined();
    expect(removed.pools.find(({ id }) => id === pool.id)).toEqual({
      ...unfrozen,
      revision: pool.revision + 1,
    });
  }
  const removedIds = new Set(
    before.matches.filter((m) => m.division === 'upper' && m.bracketId).map(({ id }) => id),
  );
  expect(removed.settings.queueOrder).toEqual(
    before.settings.queueOrder!.filter((id) => !removedIds.has(id)),
  );
  expect(removed.settings.queueRevision).toBe((before.settings.queueRevision ?? 0) + 1);
  expect(removed.settings.resourceRevision).toBe(before.settings.resourceRevision + 1);
  expect(await remove(input)).toEqual({ removed: 2 });
  expect(await state()).toEqual(removed);
  await expect(remove({ ...input, scope: fresh.lower.scope })).rejects.toThrow(/already used/);
  expect(await runtime.replay(planId)).toEqual(removed);

  const upper = removed.pools.find((p) => p.division === 'upper')!;
  const [first, second] = upper.order!;
  const source = removed.matches.find(
    (m) =>
      m.poolId === upper.id &&
      [m.player1Id, m.player2Id].includes(first!) &&
      [m.player1Id, m.player2Id].includes(second!),
  )!;
  await report(source, source.score2!, source.score1!);
  const corrected = await state();
  expect(corrected.pools.find((p) => p.id === upper.id)?.order?.slice(0, 2)).toEqual([
    second,
    first,
  ]);
  expect(lowerFacts(corrected)).toEqual(lowerFacts(before));
  await create((await review()).preview.revisionToken);
  const recreated = await state();
  expect(lowerFacts(recreated)).toEqual(lowerFacts(before));
  expect(recreated.brackets.filter((b) => b.division === 'upper')).toHaveLength(2);
  expect(recreated.brackets.some((b) => fresh.upper.scope.bracketIds.includes(b.id))).toBe(false);
  expect(recreated.settings.queueOrder).toEqual(removed.settings.queueOrder);
  expect(await remove(input)).toEqual({ removed: 2 });
  expect(await state()).toEqual(recreated);
  expect(await runtime.replay(planId)).toEqual(recreated);
  await eventOps.settings({
    planId,
    published: true,
    playerReports: true,
    scoreReportingMode: 'to_review',
  });
  const nextUpper = recreated.matches.find(
    (m) => m.division === 'upper' && m.bracketId && m.status === 'ready',
  )!;
  const beforeReport = (await review()).upper;
  const submitted = await otherUser.eventOps.reportScore({
    matchId: nextUpper.id,
    expectedRevision: nextUpper.revision,
    outcome: 'played',
    score1: 2,
    score2: 1,
    requestId: crypto.randomUUID(),
  });
  expect(submitted.status).toBe('pending');
  const afterReport = (await review()).upper;
  expect(afterReport.resetIssues).toEqual(['Finals have report history.']);
  const pending = await state();
  await expect(remove(request(beforeReport))).rejects.toThrow(/changed since the preview/);
  await expect(remove(request(afterReport))).rejects.toThrow(/report history/);
  expect(await state()).toEqual(pending);
  await report(nextUpper, 2, 1);
  const afterPlay = (await review()).upper;
  const played = await state();
  await expect(remove(request(afterReport))).rejects.toThrow(/changed since the preview/);
  await expect(remove(request(afterPlay))).rejects.toThrow(/actual play/);
  expect(await state()).toEqual(played);
  expect(lowerFacts(played)).toEqual(lowerFacts(before));
  expect(await runtime.replay(planId)).toEqual(played);
  const history = await nativeEventHistory(runtime, cluster.db, planId);
  expect(
    history.entries.filter(({ title }) => title === 'Unplayed Upper finals reset'),
  ).toHaveLength(1);
});
