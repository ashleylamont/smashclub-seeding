import assert from 'node:assert/strict';
import { PostgresStore } from '@rotorsoft/act-pg';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  eventMatches,
  nativeRatingIntents,
  nativeResultPublications,
  sets,
  tournamentParticipants,
  tournaments,
} from '@smashclub/db';
import {
  applyAttendance as applySqlAttendance,
  previewAttendance as previewSqlAttendance,
  softLockPools,
} from '../src/event-operations/attendance';
import {
  generateNativeBrackets,
  previewNativeBrackets,
} from '../src/event-operations/nativeBrackets';
import { reportScore } from '../src/event-operations/service';
import { getPlan, savePoolPlacements } from '../src/event-planner/plans';
import { attendancePreview } from '../src/tournament/attendance';
import {
  createNativeRuntime,
  createPostgresNativeRuntime,
  nativeStream,
  type NativeRuntime,
} from '../src/tournament/runtime';
import { Decision, type TournamentState } from '../src/tournament/schemas';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { nativeFinalsSlotReplayFixture } from './helpers/nativeFinalsSlotReplay';
import { postgresCluster } from './helpers/postgres';

let pg: Awaited<ReturnType<typeof postgresCluster>>;
beforeAll(async () => {
  pg = await postgresCluster();
});
afterAll(async () => {
  await pg?.close();
});

async function prepareLegacy(confirmedInSql: boolean) {
  const planId = await seedNativeDraft(pg.db);
  await softLockPools(pg.db, nativeAdmin, planId);
  const matches = () =>
    pg.db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
  const score = (match: typeof eventMatches.$inferSelect) =>
    reportScore(pg.db, nativeAdmin, {
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: crypto.randomUUID(),
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
  for (const match of await matches()) await score(match);
  const plan = (await getPlan(pg.db, planId))!;
  for (const division of plan.divisions)
    await savePoolPlacements(
      pg.db,
      planId,
      division.division,
      division.pools
        .filter(
          ({ poolIndex }) => confirmedInSql || division.division !== 'upper' || poolIndex !== 0,
        )
        .map((pool) => ({
          poolIndex: pool.poolIndex,
          expectedPlacementRevision: pool.placementRevision,
          expectedMatchRevisions: pool.matchRevisions,
          playerIdsInOrder: pool.members.map(({ playerId }) => playerId).reverse(),
        })),
    );
  const draw = await previewNativeBrackets(pg.db, planId);
  await generateNativeBrackets(pg.db, nativeAdmin, planId, draw.revisionToken);
  const played = (await matches()).find(
    (match) => match.division === 'lower' && match.stage !== 'group' && match.status === 'ready',
  )!;
  await score(played);
  return { planId, playedId: played.id };
}

function targetPool(state: TournamentState) {
  return state.pools.find(({ division, index }) => division === 'upper' && index === 0)!;
}

async function damagedLegacy(confirmedInSql: boolean, planId: string) {
  const store = new PostgresStore({
    connectionString: pg.connectionString,
    schema: 'native_act',
    table: 'events',
  });
  await store.seed();
  const writer = createNativeRuntime(pg.db, store);
  try {
    await writer.recover();
    const initial = await writer.state(planId);
    const { id, revision, entrantIds } = targetPool(initial);
    if (!confirmedInSql)
      await writer.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'poolOrders',
        pools: [
          {
            poolId: id,
            expectedRevision: revision,
            order: entrantIds.toReversed(),
            matchRevisions: Object.fromEntries(
              initial.matches
                .filter((match) => match.poolId === id)
                .map((match) => [match.id, match.revision]),
            ),
          },
        ],
      });
    const before = await writer.state(planId);
    const pool = targetPool(before);
    const requestId = crypto.randomUUID();
    const commit = store.commit.bind(store);
    store.commit = (stream, messages, ...args) =>
      commit(
        stream,
        messages.map((message) => {
          if (stream !== nativeStream(planId) || message.name !== 'DecisionRecordedV1')
            return message;
          const fact = Decision.parse(message.data);
          if (fact.requestId !== requestId) return message;
          // Emulate the pre-#210 writer's exact pool patch. All other payload fields,
          // receipts, event versions and metadata go through the normal Act writer.
          expect(fact.after.pools).toBeUndefined();
          return Object.assign({}, message, {
            data: {
              ...fact,
              after: {
                ...fact.after,
                pools: before.pools.map((item) =>
                  item.id === pool.id
                    ? { ...item, order: null, revision: item.revision + 1 }
                    : item,
                ),
              },
            },
          });
        }),
        ...args,
      );
    const playerId = pool.order!.at(-1)!;
    if (confirmedInSql) {
      await writer.command(nativeAdmin, planId, requestId, {
        kind: 'availability',
        playerId,
        availability: 'withdrawn',
        expectedRevision: before.entrants.find((entrant) => entrant.playerId === playerId)!
          .revision,
        reason: 'Player left after finals used the pool order',
      });
    } else {
      const input = {
        action: 'withdraw' as const,
        playerId,
        reason: 'Player left after finals used the pool order',
      };
      const preview = attendancePreview(before, input);
      assert(preview.allowed, preview.issues.join(' '));
      await writer.command(nativeAdmin, planId, requestId, {
        kind: 'attendance',
        ...input,
        approveRedistribution: false,
        revisionToken: preview.revisionToken,
      });
    }
    return { before, originalOrder: pool.order!, poolId: pool.id };
  } finally {
    await writer.shutdown();
  }
}

async function seal(runtime: NativeRuntime, planId: string) {
  for (let count = 0; count < 100; count++) {
    const state = await runtime.state(planId);
    const match =
      state.matches.find(({ status }) => status === 'ready') ??
      state.matches.find(
        ({ status, blockedReason }) =>
          status === 'blocked' && blockedReason?.includes('forfeit decision'),
      );
    if (!match) break;
    const reverse = state.entrants.some(
      (entrant) => entrant.playerId === match.player1Id && entrant.availability === 'withdrawn',
    );
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'score',
      matchId: match.id,
      expectedRevision: match.revision,
      outcome: match.status === 'blocked' ? 'forfeit' : 'played',
      score1: reverse ? 0 : 2,
      score2: reverse ? 2 : 0,
    });
  }
  await runtime.command(nativeAdmin, planId, crypto.randomUUID(), { kind: 'finalize' });
  await runtime.drainReactions();
}

async function publishedFacts(state: TournamentState) {
  const publication = state.publication!;
  const ids = publication.tournamentIds;
  const revisions = await pg.db
    .select()
    .from(nativeResultPublications)
    .where(eq(nativeResultPublications.eventPlanId, state.baseline!.planId))
    .orderBy(nativeResultPublications.revision);
  return {
    revisions,
    rating: await pg.db
      .select()
      .from(nativeRatingIntents)
      .where(
        inArray(
          nativeRatingIntents.resultId,
          revisions.map(({ resultId }) => resultId),
        ),
      )
      .orderBy(nativeRatingIntents.resultId),
    tournaments: await pg.db
      .select()
      .from(tournaments)
      .where(inArray(tournaments.id, ids))
      .orderBy(tournaments.id),
    participants: await pg.db
      .select()
      .from(tournamentParticipants)
      .where(inArray(tournamentParticipants.tournamentId, ids))
      .orderBy(tournamentParticipants.id),
    sets: await pg.db.select().from(sets).where(inArray(sets.tournamentId, ids)).orderBy(sets.id),
  };
}

it.each(['locked', 'published'] as const)(
  'restores only the verified original order on a %s V1 stream',
  async (phase) => {
    const { planId, playedId } = await prepareLegacy(phase === 'locked');
    const { before, originalOrder, poolId } = await damagedLegacy(phase === 'locked', planId);
    const open = () => createPostgresNativeRuntime(pg.db, pg.connectionString);
    let runtime = await open();
    try {
      const damaged = await runtime.state(planId);
      expect(targetPool(damaged).order).toBeNull();
      expect(damaged.matches.find(({ id }) => id === playedId)).toEqual(
        before.matches.find(({ id }) => id === playedId),
      );
      if (phase === 'published') {
        // Real later decisions put the original confirmation and publication on
        // different review pages without changing the affected pool or draw.
        for (let i = 0; i < 16; i++)
          await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
            kind: 'announce',
            message: `Historical event update ${i + 1}`,
            durationSeconds: null,
          });
        await seal(runtime, planId);
      }
      const fixture = nativeFinalsSlotReplayFixture(pg, runtime);
      const { eventOps, admin } = fixture.caller();
      const reviewArgs = { planId, poolId };
      const ordinaryUser = fixture.caller({ ...nativeAdmin, role: 'user' });
      await expect(
        ordinaryUser.eventOps.live.previewLegacyPoolOrderRepair(reviewArgs),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const worksheet = () => admin.eventPlanner.plan({ planId });
      const worksheetPool = async () =>
        (await worksheet())!.divisions.find(({ division }) => division === 'upper')!.pools[0]!;
      expect((await worksheetPool()).legacyOrderRepairPoolId).toBe(poolId);
      const publicOrder = async () =>
        (await fixture.caller(null).eventOps.snapshot({ planId })).placements
          .filter(({ division, poolIndex }) => division === 'upper' && poolIndex === 0)
          .map(({ playerId }) => playerId);
      expect(await publicOrder()).toEqual([]);

      const read = () => eventOps.live.previewLegacyPoolOrderRepair(reviewArgs);
      const query = runtime.app.query_array.bind(runtime.app);
      const incomplete = vi
        .spyOn(runtime.app, 'query_array')
        .mockImplementation(async (input) =>
          (await query(input)).filter(({ name }) => name !== 'LegacyStateImportedV1'),
        );
      try {
        expect(await read()).toMatchObject({ allowed: false });
      } finally {
        incomplete.mockRestore();
      }
      const pages = vi.spyOn(runtime.app, 'query_array');
      const reviewed = await read();
      if (phase === 'published') {
        const cursors = pages.mock.calls.map(([{ after }]) => after!);
        assert(cursors.length > 1, 'The published journal must span more than one page');
        assert.deepEqual(
          cursors,
          [...new Set(cursors)].sort((a, b) => a - b),
        );
      }
      pages.mockRestore();
      if (!reviewed.allowed) throw new Error(reviewed.reason);
      expect(reviewed.evidence.order).toEqual(originalOrder);
      expect(reviewed.evidence.confirmation.source).toBe(
        phase === 'locked' ? 'imported' : 'confirmed',
      );
      expect(reviewed.evidence.withdrawal.id).toBeGreaterThan(reviewed.evidence.confirmation.id);
      const intent = (preview: typeof reviewed) => ({
        ...reviewArgs,
        requestId: crypto.randomUUID(),
        expectedSequence: preview.expectedSequence,
        expectedPoolRevision: preview.expectedPoolRevision,
        revisionToken: preview.revisionToken,
        reason: 'Verified the original order and withdrawal in the journal',
      });
      const apply = eventOps.live.restoreLegacyPoolOrder;
      await expect(
        ordinaryUser.eventOps.live.restoreLegacyPoolOrder(intent(reviewed)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        eventOps.live.command({
          planId,
          requestId: crypto.randomUUID(),
          command: {
            ...intent(reviewed),
            kind: 'restoreLegacyPoolOrder',
            evidence: reviewed.evidence,
          },
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        apply({ ...intent(reviewed), revisionToken: '0'.repeat(64) }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const forged = {
        ...intent(reviewed),
        evidence: { ...reviewed.evidence, order: originalOrder.toReversed() },
      };
      await expect(apply(forged)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      if (phase === 'locked') {
        let scanned!: () => void;
        let resume!: () => void;
        const scanComplete = new Promise<void>((resolve) => (scanned = resolve));
        const resumeAppend = new Promise<void>((resolve) => (resume = resolve));
        const scan = runtime.reviewLegacyPoolOrder.bind(runtime);
        const hold = vi
          .spyOn(runtime, 'reviewLegacyPoolOrder')
          .mockImplementationOnce(async (...args) => {
            const verified = await scan(...args);
            scanned();
            await resumeAppend;
            return verified;
          });
        const raced = assert.rejects(apply(intent(reviewed)), /event changed/i);
        const concurrent = await open();
        try {
          await scanComplete;
          await concurrent.command(nativeAdmin, planId, crypto.randomUUID(), {
            kind: 'announce',
            message: 'An unrelated event update',
            durationSeconds: null,
          });
        } finally {
          resume();
          hold.mockRestore();
          await concurrent.shutdown();
        }
        await raced;
      }
      const latest = await read();
      if (!latest.allowed) throw new Error(latest.reason);
      const exact = intent(latest);
      const prior = await runtime.state(planId);
      const published = prior.publication ? await publishedFacts(prior) : null;
      if (phase === 'published') {
        assert.equal(prior.result?.version, 1);
        assert(!Object.hasOwn(prior.result, 'poolOrders'));
        assert(published && published.sets.length > 0);
      }
      const applied = await apply(exact);
      const restored = await runtime.state(planId);
      expect(restored).toEqual({
        ...prior,
        sequence: prior.sequence + 1,
        receipts: restored.receipts,
        pools: prior.pools.map((pool) =>
          pool.id === poolId
            ? { ...pool, order: originalOrder, revision: pool.revision + 1 }
            : pool,
        ),
      });
      expect(Object.keys(restored.receipts)).toHaveLength(Object.keys(prior.receipts).length + 1);
      expect((await worksheetPool()).legacyOrderRepairPoolId).toBeUndefined();
      expect(await publicOrder()).toEqual(originalOrder);
      expect(
        (await worksheetPool()).members
          .toSorted((a, b) => a.place! - b.place!)
          .map(({ playerId }) => playerId),
      ).toEqual(originalOrder);
      expect(
        (await eventOps.live.snapshot({ planId })).pools.find(({ id }) => id === poolId)?.order,
      ).toEqual(originalOrder);
      const history = await eventOps.live.history({ planId });
      expect(history.entries[0]).toMatchObject({
        eventName: 'DecisionRecordedV11',
        title: 'Original pool order restored',
        summary: exact.reason,
      });
      expect(await read()).toMatchObject({ allowed: false });
      if (published) assert.deepEqual(await publishedFacts(restored), published);

      await runtime.shutdown();
      await pg.pool.query('delete from native_act.events where stream=$1 and name=$2', [
        nativeStream(planId),
        '__snapshot__',
      ]);
      runtime = await open();
      const restarted = nativeFinalsSlotReplayFixture(pg, runtime).caller().eventOps.live;
      expect(await restarted.restoreLegacyPoolOrder(exact)).toEqual(applied);
      await expect(
        restarted.restoreLegacyPoolOrder({ ...exact, reason: 'Changed reason' }),
      ).rejects.toThrow(/different command/);
      expect(await runtime.state(planId)).toEqual(restored);
      expect(await runtime.replay(planId)).toEqual(restored);
    } finally {
      await runtime.shutdown();
    }
  },
);

it('refuses an order erased by SQL before the journal started, even with a frozen draw', async () => {
  const { planId } = await prepareLegacy(true);
  const worksheet = (await getPlan(pg.db, planId))!;
  const original = worksheet.divisions.find(({ division }) => division === 'upper')!.pools[0]!;
  const input = {
    planId,
    action: 'withdraw' as const,
    playerId: original.members[0]!.playerId,
    reason: 'Left during legacy finals',
  };
  const preview = await previewSqlAttendance(pg.db, input);
  expect(preview.allowed).toBe(true);
  await applySqlAttendance(pg.db, nativeAdmin, { ...input, revisionToken: preview.revisionToken });
  const runtime = await createPostgresNativeRuntime(pg.db, pg.connectionString);
  try {
    await runtime.recover();
    const imported = await runtime.state(planId);
    const { id: poolId, order, revision } = targetPool(imported);
    expect(order).toBeNull();
    expect(imported.brackets).not.toHaveLength(0);
    const { eventOps } = nativeFinalsSlotReplayFixture(pg, runtime).caller();
    expect(await eventOps.live.previewLegacyPoolOrderRepair({ planId, poolId })).toMatchObject({
      allowed: false,
    });
    await expect(
      eventOps.live.restoreLegacyPoolOrder({
        planId,
        poolId,
        expectedSequence: imported.sequence,
        expectedPoolRevision: revision,
        reason: 'No journal evidence',
        requestId: crypto.randomUUID(),
        revisionToken: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await runtime.replay(planId)).toEqual(imported);
  } finally {
    await runtime.shutdown();
  }
});
