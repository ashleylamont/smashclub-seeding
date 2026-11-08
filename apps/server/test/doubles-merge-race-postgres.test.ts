import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { players, playerClaims, user } from '@smashclub/db';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createPlan, freezeRoster, generatePools } from '../src/event-planner/plans';
import { addDoublesPair } from '../src/event-planner/nativePlanner';
import { createPostgresNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { mergePlayers } from '../src/players/merge';

function gate() {
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release, paused, resumed };
}

async function runRace(
  first: 'substitution' | 'merge',
  cluster: Awaited<ReturnType<typeof postgresCluster>>,
  a: NativeRuntime,
  b: NativeRuntime,
) {
  const participant = {
    ...nativeAdmin,
    id: 'late-participant',
    name: 'Late participant',
    email: 'late@example.test',
    role: 'user' as const,
  };
  await cluster.db.insert(user).values([nativeAdmin, participant]);
  const profiles = await cluster.db
    .insert(players)
    .values(
      Array.from({ length: 10 }, (_, i) => ({
        canonicalName: `Race member ${i}`,
        displayName: `Race alias ${i}`,
      })),
    )
    .returning();
  const [incoming, survivor] = profiles.slice(8);
  await cluster.db
    .insert(playerClaims)
    .values({ userId: participant.id, playerId: incoming!.id, status: 'approved' });
  const planId = await createPlan(
    cluster.db,
    {
      name: 'Doubles substitution profile merge race',
      eventDate: new Date('2026-10-01'),
      competitionFormat: 'doubles',
      structure: 'round_robin',
      rows: [],
    },
    nativeAdmin.id,
  );
  for (let i = 0; i < 4; i++)
    await addDoublesPair(cluster.db, {
      planId,
      playerId: profiles[i * 2]!.id,
      partnerPlayerId: profiles[i * 2 + 1]!.id,
      teamName: null,
    });
  await freezeRoster(cluster.db, planId);
  await generatePools(cluster.db, planId);
  await a.lock(nativeAdmin, planId);
  await a.command(nativeAdmin, planId, 'open-reporting', {
    kind: 'reporting',
    published: true,
    playerReports: true,
    mode: 'approve_unless_disputed',
    expectedRevision: 0,
  });
  const before = await a.state(planId);
  const slot = before.entrants[0]!;
  const change = {
    planId,
    entrantId: slot.id,
    outgoingPlayerId: slot.memberPlayerIds![1]!,
    incomingPlayerId: incoming!.id,
    reason: 'Partner unavailable',
  };

  const lock = gate();
  let committedSequence: number | undefined;
  const gated: NativeRuntime = {
    ...a,
    async command(...args) {
      if (first === 'substitution' && args[3].kind === 'substituteDoublesMember') {
        lock.reached();
        await lock.resumed;
        const { receipt } = await a.command(...args);
        committedSequence = receipt.sequence;
        // Confirm the surrounding SQL transaction really rolls back when
        // the response is lost after Act has already stored its receipt.
        await args[5]!
          .update(players)
          .set({ displayName: 'Uncommitted transaction marker' })
          .where(eq(players.id, incoming!.id));
        throw new Error('Response lost after journal append');
      }
      return a.command(...args);
    },
  };
  const merger: NativeRuntime = {
    ...b,
    async transfer(...args) {
      if (first === 'merge') {
        lock.reached();
        await lock.resumed;
      }
      return b.transfer(...args);
    },
  };
  const caller = (
    nativeRuntime: NativeRuntime,
    callerUser: typeof nativeAdmin | typeof participant | null,
  ) =>
    appRouter.createCaller({
      db: cluster.db,
      user: callerUser,
      nativeRuntime,
      env: loadEnv({ DATABASE_URL: cluster.connectionString, NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(cluster.db),
    });
  const operator = caller(gated, nativeAdmin).eventOps;
  const preview = await operator.previewDoublesSubstitution(change);
  expect(preview.allowed).toBe(true);
  const apply = { ...change, requestId: 'merge-race', revisionToken: preview.revisionToken };
  const startMerge = () => mergePlayers(cluster.db, incoming!.id, survivor!.id, merger);
  const startSubstitution = () => operator.applyDoublesSubstitution(apply);
  const firstWriter = first === 'merge' ? startMerge() : startSubstitution();
  await Promise.race([
    lock.paused,
    firstWriter.then(() => {
      throw new Error('The first writer completed before the controlled lock point.');
    }),
  ]);
  const secondWriter = first === 'merge' ? startSubstitution() : startMerge();
  const done = Promise.allSettled([firstWriter, secondWriter]);
  try {
    await expect
      .poll(
        async () => {
          const blocked = await cluster.pool.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'
           AND query ILIKE '%for no key update%' AND cardinality(pg_blocking_pids(pid)) > 0`,
          );
          return blocked.rowCount;
        },
        { timeout: 3000 },
      )
      .toBe(1);
  } finally {
    lock.release();
  }
  const [winner, loser] = await done;
  const [profile] = await cluster.db.select().from(players).where(eq(players.id, incoming!.id));
  const saved = await b.replay(planId);
  const pair = saved.entrants.find(({ id }) => id === slot.id)!;
  const publicState = await caller(b, null).eventOps.snapshot({ planId });
  const { attendees } = await caller(b, nativeAdmin).eventOps.attendeeRoster({ planId });
  expect(attendees.filter(({ entryId }) => entryId === slot.id)).toHaveLength(2);
  const [claim] = await caller(b, participant).me.claims();
  return {
    winner,
    loser,
    profile,
    pair,
    slot,
    claim,
    saved,
    committedSequence,
    incoming,
    survivor,
    publicPair: publicState.entrants.find(({ id }) => id === slot.id),
    previewAgain: () => operator.previewDoublesSubstitution(change),
    retryAfterRename: async () => {
      await cluster.db
        .update(players)
        .set({ displayName: 'Alias changed after response loss' })
        .where(eq(players.id, incoming!.id));
      return caller(b, nativeAdmin).eventOps.applyDoublesSubstitution(apply);
    },
    repeatDifferentIntent: () =>
      caller(b, nativeAdmin).eventOps.applyDoublesSubstitution({
        ...apply,
        reason: 'Different intent',
      }),
    replay: () => b.replay(planId),
  };
}

async function withRace(
  first: 'substitution' | 'merge',
  verify: (race: Awaited<ReturnType<typeof runRace>>) => Promise<void>,
) {
  const cluster = await postgresCluster();
  const a = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
  const b = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
  try {
    await verify(await runRace(first, cluster, a, b));
  } finally {
    await a.shutdown();
    await b.shutdown();
    await cluster.close();
  }
}

it('waits for the substitution append and recovers its exact receipt after SQL rollback', async () => {
  await withRace('substitution', async (race) => {
    expect(race.winner).toMatchObject({
      status: 'rejected',
      reason: { message: 'Response lost after journal append' },
    });
    expect(race.loser).toMatchObject({
      status: 'rejected',
      reason: {
        message: expect.stringContaining(
          'Cannot merge players while either identity is used by active event',
        ),
      },
    });
    expect(race.profile).toMatchObject({
      status: 'active',
      mergedIntoPlayerId: null,
      displayName: race.incoming!.displayName,
    });
    expect(race.pair.memberPlayerIds).toContain(race.incoming!.id);
    expect(race.claim).toMatchObject({ status: 'approved', playerId: race.incoming!.id });
    expect(race.publicPair).toMatchObject({
      memberPlayerIds: expect.arrayContaining([race.claim!.playerId]),
    });
    expect(race.committedSequence).toEqual(expect.any(Number));
    expect(await race.retryAfterRename()).toEqual({
      applied: true,
      sequence: race.committedSequence,
    });
    await expect(race.repeatDifferentIntent()).rejects.toThrow(/request identifier already used/i);
    expect(await race.replay()).toEqual(race.saved);
  });
});

it('waits for a profile merge and rejects the reviewed substitution against the now-tombstoned ID', async () => {
  await withRace('merge', async (race) => {
    expect(race.winner).toMatchObject({ status: 'fulfilled' });
    expect(race.loser).toMatchObject({
      status: 'rejected',
      reason: { message: 'The pair changed since this preview. Review the substitution again.' },
    });
    expect(race.profile).toMatchObject({ status: 'merged', mergedIntoPlayerId: race.survivor!.id });
    expect(race.pair).toEqual(race.slot);
    expect(race.claim).toMatchObject({ status: 'approved', playerId: race.survivor!.id });
    expect((await race.previewAgain()).allowed).toBe(false);
  });
});
