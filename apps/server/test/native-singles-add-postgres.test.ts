import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { players } from '@smashclub/db';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createPostgresNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { mergePlayers } from '../src/players/merge';

type Cluster = Awaited<ReturnType<typeof postgresCluster>>;

function eventOps(
  cluster: Cluster,
  nativeRuntime: NativeRuntime,
  user: typeof nativeAdmin | null = nativeAdmin,
) {
  return appRouter.createCaller({
    db: cluster.db,
    user,
    nativeRuntime,
    env: loadEnv({ DATABASE_URL: cluster.connectionString, NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(cluster.db),
  }).eventOps;
}

async function runRace(
  first: 'add' | 'merge',
  cluster: Cluster,
  addRuntime: NativeRuntime,
  mergeRuntime: NativeRuntime,
) {
  const planId = await seedNativeDraft(cluster.db);
  const [incoming, survivor] = await cluster.db
    .insert(players)
    .values([{ canonicalName: 'Late singles entrant' }, { canonicalName: 'Surviving profile' }])
    .returning();
  await addRuntime.lock(nativeAdmin, planId);
  const before = await addRuntime.replay(planId);

  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gatedAdd: NativeRuntime = {
    ...addRuntime,
    async command(...args) {
      if (first !== 'add' || args[3].kind !== 'attendance' || args[3].action !== 'add')
        return addRuntime.command(...args);
      expect(args[3].entrant?.name).toBe(incoming!.canonicalName);
      reached();
      await resumed;
      await addRuntime.command(...args);
      throw new Error('Response lost after Add append');
    },
  };
  const gatedMerge: NativeRuntime = {
    ...mergeRuntime,
    async transfer(...args) {
      if (first === 'merge') {
        reached();
        await resumed;
      }
      return mergeRuntime.transfer(...args);
    },
  };
  const input = {
    planId,
    action: 'add' as const,
    playerId: incoming!.id,
    division: 'upper' as const,
    reason: 'Arrived late',
    requestId: 'late-add-race',
  };
  const preview = await eventOps(cluster, addRuntime).previewAttendance(input);
  expect(preview.allowed).toBe(true);
  const approved = { ...input, revisionToken: preview.revisionToken };
  const add = () => eventOps(cluster, gatedAdd).applyAttendance(approved);
  const merge = () => mergePlayers(cluster.db, incoming!.id, survivor!.id, gatedMerge);
  const firstWriter = first === 'add' ? add() : merge();
  const firstDone = Promise.allSettled([firstWriter]);
  let done: Promise<PromiseSettledResult<Awaited<typeof firstWriter>>[]> = firstDone;
  try {
    await Promise.race([
      paused,
      firstDone.then(() => {
        throw new Error('First writer never reached the lock barrier.');
      }),
    ]);
    done = Promise.allSettled([firstWriter, first === 'add' ? merge() : add()]);
    await expect
      .poll(
        async () => {
          const blocked = await cluster.pool.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND query ILIKE '%for no key update%' AND cardinality(pg_blocking_pids(pid)) > 0`,
          );
          return blocked.rowCount;
        },
        { timeout: 2500 },
      )
      .toBe(1);
  } finally {
    release();
    await done;
  }
  const [winner, loser] = await done;
  const saved = await mergeRuntime.replay(planId);
  const [profile] = await cluster.db.select().from(players).where(eq(players.id, incoming!.id));
  const publicBoard = await eventOps(cluster, mergeRuntime, null).snapshot({ planId });
  const organiserBoard = await eventOps(cluster, mergeRuntime).attendeeRoster({ planId });
  const recovered = eventOps(cluster, mergeRuntime);
  return {
    winner,
    loser,
    before,
    saved,
    profile,
    incoming: incoming!,
    survivor: survivor!,
    publicHasEntrant: publicBoard.entrants.some(({ id }) => id === incoming!.id),
    organiserHasEntrant: organiserBoard.attendees.some(({ playerId }) => playerId === incoming!.id),
    original: { applied: true, addedMatches: preview.addedMatches, affectedMatches: 0 },
    retry: (reason = approved.reason) => recovered.applyAttendance({ ...approved, reason }),
    replay: () => mergeRuntime.replay(planId),
    async removeAndMerge() {
      const noShow = { ...input, action: 'no_show' as const, requestId: 'remove-late' };
      const removal = await recovered.previewAttendance(noShow);
      expect(removal.allowed).toBe(true);
      await recovered.applyAttendance({ ...noShow, revisionToken: removal.revisionToken });
      await mergePlayers(cluster.db, incoming!.id, survivor!.id, mergeRuntime);
    },
  };
}

async function withRuntimes(
  verify: (cluster: Cluster, a: NativeRuntime, b: NativeRuntime) => Promise<void>,
) {
  const cluster = await postgresCluster();
  const addRuntime = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
  const mergeRuntime = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
  try {
    await verify(cluster, addRuntime, mergeRuntime);
  } finally {
    await addRuntime.shutdown();
    await mergeRuntime.shutdown();
    await cluster.close();
  }
}

it('holds the identity lock through Add and recovers the response after a later merge', async () => {
  await withRuntimes(async (cluster, a, b) => {
    const race = await runRace('add', cluster, a, b);
    expect(race.winner).toMatchObject({
      status: 'rejected',
      reason: { message: 'Response lost after Add append' },
    });
    expect(race.loser).toMatchObject({
      status: 'rejected',
      reason: { code: 'CONFLICT', message: expect.stringContaining('used by active event') },
    });
    expect(race.profile).toMatchObject({ status: 'active', mergedIntoPlayerId: null });
    expect(race.saved.sequence).toBe(race.before.sequence + 1);
    expect(race.saved.entrants.find(({ playerId }) => playerId === race.incoming.id)?.name).toBe(
      race.incoming.canonicalName,
    );
    expect(race.publicHasEntrant).toBe(true);
    expect(race.organiserHasEntrant).toBe(true);
    expect(await race.retry()).toEqual(race.original);
    expect(await race.replay()).toEqual(race.saved);

    await race.removeAndMerge();
    const afterMerge = await race.replay();
    expect(await race.retry()).toEqual(race.original);
    await expect(race.retry('Different request')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await race.replay()).toEqual(afterMerge);
  });
});

it('rejects the reviewed Add before journaling when a profile merge gets the lock first', async () => {
  await withRuntimes(async (cluster, a, b) => {
    const race = await runRace('merge', cluster, a, b);
    expect(race.winner).toMatchObject({ status: 'fulfilled' });
    expect(race.loser).toMatchObject({ status: 'rejected', reason: { code: 'BAD_REQUEST' } });
    expect(race.profile).toMatchObject({ status: 'merged', mergedIntoPlayerId: race.survivor.id });
    expect(race.saved).toEqual(race.before);
    expect(race.publicHasEntrant).toBe(false);
    expect(race.organiserHasEntrant).toBe(false);
  });
});

it('rejects simultaneous reuse of one request ID for a different player', async () => {
  await withRuntimes(async (cluster, a, b) => {
    const planId = await seedNativeDraft(cluster.db);
    const profiles = await cluster.db
      .insert(players)
      .values([{ canonicalName: 'First candidate' }, { canonicalName: 'Second candidate' }])
      .returning();
    await a.lock(nativeAdmin, planId);
    const before = await a.replay(planId);
    const requestId = 'duplicate-add-id';
    const approved = await Promise.all(
      profiles.map(async (profile) => {
        const input = {
          planId,
          requestId,
          playerId: profile.id,
          action: 'add' as const,
          division: 'upper' as const,
        };
        const preview = await eventOps(cluster, a).previewAttendance(input);
        expect(preview.allowed).toBe(true);
        return { ...input, revisionToken: preview.revisionToken };
      }),
    );

    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atAppend = (runtime: NativeRuntime): NativeRuntime => ({
      ...runtime,
      async command(...args) {
        arrivals++;
        if (arrivals === 2) release();
        await bothReady;
        return runtime.command(...args);
      },
    });
    const done = Promise.allSettled([
      eventOps(cluster, atAppend(a)).applyAttendance(approved[0]!),
      eventOps(cluster, atAppend(b)).applyAttendance(approved[1]!),
    ]);
    try {
      await expect.poll(() => arrivals, { timeout: 2500 }).toBe(2);
    } finally {
      release();
      await done;
    }
    const results = await done;
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: {
        code: 'CONFLICT',
        message: 'Request identifier already used for a different command.',
      },
    });
    const saved = await b.replay(planId);
    expect(saved.sequence).toBe(before.sequence + 1);
    const admitted = profiles[results.findIndex(({ status }) => status === 'fulfilled')]!;
    expect(
      saved.entrants.filter(({ playerId }) => profiles.some(({ id }) => id === playerId)),
    ).toEqual([expect.objectContaining({ playerId: admitted.id })]);
  });
});
