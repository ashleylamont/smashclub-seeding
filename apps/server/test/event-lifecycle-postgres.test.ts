import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultRatingSettings } from '@smashclub/shared';
import { eq } from 'drizzle-orm';
import {
  eventMatches,
  eventPoolAssignments,
  eventPlans,
  playerRatings,
  ratingEvents,
  sets,
  tournaments,
} from '@smashclub/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { softLockPools } from '../src/event-operations/attendance';
import { reportScore, updateMatch, prepare } from '../src/event-operations/service';
import {
  finalizeNativeEvent,
  generateNativeBrackets,
  previewNativeBrackets,
} from '../src/event-operations/nativeBrackets';
import { getPlan, savePoolPlacements } from '../src/event-planner/plans';
import { runRecompute } from '../src/recompute/recompute';
import { updateRatingSettings } from '../src/settings';
import { postgresCluster, migrationsFolder, contend } from './helpers/postgres';
import { nativeFixture, scoreInput, to } from './helpers/nativeFixture';

let cluster: Awaited<ReturnType<typeof postgresCluster>>;
beforeAll(async () => {
  cluster = await postgresCluster();
});
afterAll(async () => cluster?.close());

it('preserves a soft-locked draw across connections, rejects unsafe corrections and finalizes once after rollback', async () => {
  const { planId } = await nativeFixture(cluster.db, 14);
  const locked = await softLockPools(cluster.db, to, planId);
  expect(await softLockPools(cluster.db, to, planId)).toEqual(locked);
  const assignments = await cluster.db
    .select()
    .from(eventPoolAssignments)
    .where(eq(eventPoolAssignments.eventPlanId, planId));
  const reopened = cluster.connect();
  try {
    await migrate(drizzle(reopened.pool), { migrationsFolder });
    await prepare(reopened.db, planId);
    expect(
      await reopened.db
        .select()
        .from(eventPoolAssignments)
        .where(eq(eventPoolAssignments.eventPlanId, planId)),
    ).toEqual(assignments);
    expect(
      (
        await reopened.db.select().from(eventPlans).where(eq(eventPlans.id, planId))
      )[0]!.softLockedAt!.toISOString(),
    ).toBe(locked.softLockedAt);
    // A forfeit advances without becoming a played/rated game.
    const pools = await reopened.db
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.eventPlanId, planId));
    for (const [index, match] of pools.entries())
      await reportScore(reopened.db, to, {
        ...scoreInput(match, `pool-${index}`),
        ...(index === 0
          ? { outcome: 'forfeit' as const, score1: 0, score2: 0, winnerId: match.player1Id! }
          : {}),
      });
    const view = (await getPlan(reopened.db, planId))!;
    for (const division of view.divisions)
      await savePoolPlacements(
        reopened.db,
        planId,
        division.division,
        division.pools.map((pool) => ({
          poolIndex: pool.poolIndex,
          playerIdsInOrder: pool.members.map((member) => member.playerId),
          expectedMatchRevisions: pool.matchRevisions,
          expectedPlacementRevision: pool.placementRevision,
        })),
      );
    const preview = await previewNativeBrackets(reopened.db, planId);
    expect(preview.issues).toEqual([]);
    await generateNativeBrackets(reopened.db, to, planId, preview.revisionToken);
    const first = (
      await reopened.db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId))
    ).find((m) => m.nativeBracketId && m.status === 'ready')!;
    await reportScore(reopened.db, to, scoreInput(first, 'final-first'));
    const child = (
      await reopened.db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId))
    ).find((m) => m.parent1MatchId === first.id || m.parent2MatchId === first.id)!;
    // Finish the sibling so the child is actually playable.
    const siblingId =
      child.parent1MatchId === first.id ? child.parent2MatchId : child.parent1MatchId;
    const sibling = siblingId
      ? (await reopened.db.select().from(eventMatches).where(eq(eventMatches.id, siblingId)))[0]
      : undefined;
    if (sibling?.status === 'ready')
      await reportScore(reopened.db, to, scoreInput(sibling, 'final-sibling'));
    const readyChild = (
      await reopened.db.select().from(eventMatches).where(eq(eventMatches.id, child.id))
    )[0]!;
    await updateMatch(reopened.db, to, {
      matchId: child.id,
      expectedRevision: readyChild.revision,
      status: 'playing',
    });
    const before = (
      await reopened.db.select().from(eventMatches).where(eq(eventMatches.id, first.id))
    )[0]!;
    await expect(
      reportScore(reopened.db, to, {
        ...scoreInput(before, 'unsafe-correction'),
        score1: 0,
        score2: 2,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (await reopened.db.select().from(eventMatches).where(eq(eventMatches.id, first.id)))[0],
    ).toEqual(before);
    for (let round = 0; round < 10; round++) {
      const remaining = (
        await reopened.db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId))
      ).filter((m) => m.nativeBracketId && ['ready', 'playing'].includes(m.status));
      if (!remaining.length) break;
      for (const match of remaining)
        await reportScore(reopened.db, to, scoreInput(match, `finish-${match.sourceKey}`));
    }
  } finally {
    await reopened.pool.end();
  }
  const completed = await cluster.db
    .select()
    .from(eventMatches)
    .where(eq(eventMatches.eventPlanId, planId));
  expect(completed.every((m) => m.status === 'complete')).toBe(true);
  expect(completed.some((m) => m.outcome === 'bye')).toBe(true);
  expect(completed.filter((m) => m.outcome === 'forfeit')).toHaveLength(1);
  // Fail after at least one result has been written, exercising full-event atomicity.
  await cluster.pool.query(
    "CREATE FUNCTION fail_final_set() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result_stage = 'final' THEN RAISE EXCEPTION 'synthetic final result failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_final_set BEFORE INSERT ON sets FOR EACH ROW EXECUTE FUNCTION fail_final_set()",
  );
  try {
    await expect(finalizeNativeEvent(cluster.db, to, planId)).rejects.toMatchObject({
      cause: { message: 'synthetic final result failure' },
    });
    expect(await cluster.db.select().from(tournaments)).toHaveLength(0);
    expect(await cluster.db.select().from(sets)).toHaveLength(0);
    expect(
      (await cluster.db.select().from(eventMatches)).every((m) => m.sourceSetId === null),
    ).toBe(true);
    expect((await cluster.db.select().from(eventPlans))[0]!.status).not.toBe('complete');
  } finally {
    await cluster.pool.query('DROP TRIGGER fail_final_set ON sets; DROP FUNCTION fail_final_set()');
  }
  const attempts = await contend(cluster, planId, [
    () => finalizeNativeEvent(cluster.db, to, planId),
    () => finalizeNativeEvent(cluster.db, to, planId),
  ]);
  expect(attempts.every((r) => r.status === 'fulfilled')).toBe(true);
  expect(attempts.filter((r) => r.status === 'fulfilled' && r.value.alreadyFinalized)).toHaveLength(
    1,
  );
  const stored = await cluster.db.select().from(sets);
  expect(stored).toHaveLength(completed.length);
  const unplayed = stored.filter((s) => (s.raw as { outcome: string }).outcome !== 'played');
  expect(unplayed.every((s) => s.excludedFromRatings && s.scoresCsv === null)).toBe(true);
  expect(unplayed.find((s) => (s.raw as { outcome: string }).outcome === 'forfeit')!.winner).toBe(
    1,
  );
  await updateRatingSettings(cluster.db, defaultRatingSettings);
  const firstFit = await runRecompute(cluster.db);
  expect(firstFit.model).toBe('whr');
  expect(firstFit.sets).toBe(completed.filter((m) => m.outcome === 'played').length);
  expect(firstFit.events).toBe(firstFit.sets * 2);
  const durable = cluster.connect();
  try {
    expect(await finalizeNativeEvent(durable.db, to, planId)).toEqual({ alreadyFinalized: true });
    await expect(
      reportScore(durable.db, to, scoreInput(completed[0]!, 'closed-write')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const secondFit = await runRecompute(durable.db);
    const ratings = async (id: string) =>
      (await durable.db.select().from(playerRatings).where(eq(playerRatings.recomputeId, id)))
        .map(({ id: _id, recomputeId: _run, ...row }) => row)
        .sort((a, b) => a.playerId.localeCompare(b.playerId));
    expect(await ratings(secondFit.recomputeId)).toEqual(await ratings(firstFit.recomputeId));
    const events = await durable.db
      .select()
      .from(ratingEvents)
      .where(eq(ratingEvents.recomputeId, secondFit.recomputeId));
    expect(events.every((event) => !unplayed.some((s) => s.id === event.setId))).toBe(true);
    expect(await durable.db.select().from(sets)).toHaveLength(stored.length);
  } finally {
    await durable.pool.end();
  }
});
