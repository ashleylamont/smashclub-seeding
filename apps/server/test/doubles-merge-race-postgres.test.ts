import { expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { players, playerClaims, sets, tournamentParticipants, user, type Db } from '@smashclub/db';
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
import { loadDoublesRatings } from '../src/recompute/doubles';
import type { Match } from '../src/tournament/schemas';

type Workflow = 'substitution' | 'late pair';

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
  workflow: Workflow,
  first: 'attendance' | 'merge',
  cluster: Awaited<ReturnType<typeof postgresCluster>>,
  a: NativeRuntime,
  b: NativeRuntime,
) {
  const latePair = workflow === 'late pair';
  const commandKind = latePair ? 'addLateDoublesPair' : 'substituteDoublesMember';
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
      Array.from({ length: 11 }, (_, i) => ({
        canonicalName: `Race member ${i}`,
        displayName: `Race alias ${i}`,
      })),
    )
    .returning();
  const [incoming, survivor, partner] = profiles.slice(8);
  await cluster.db
    .insert(playerClaims)
    .values({ userId: participant.id, playerId: incoming!.id, status: 'approved' });
  const planId = await createPlan(
    cluster.db,
    {
      name: `Doubles ${workflow} profile merge race`,
      eventDate: new Date('2026-10-01'),
      competitionFormat: 'doubles',
      structure: latePair ? 'pools_finals' : 'round_robin',
      ...(latePair && { structureOptions: { roundRobinMeetings: 2, consolation: true } }),
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

  const lateChange = {
    planId,
    division: 'upper' as const,
    memberPlayerIds: [partner!.id, incoming!.id] as [string, string],
    reason: 'Both members arrived before pool play',
  };

  const lock = gate();
  let committedSequence: number | undefined;
  const gated: NativeRuntime = {
    ...a,
    async command(...args) {
      if (first === 'attendance' && args[3].kind === commandKind) {
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
  const review = () =>
    latePair
      ? operator.previewLateDoublesPair(lateChange)
      : operator.previewDoublesSubstitution(change);
  const preview = await review();
  expect(preview.allowed).toBe(true);
  const intent = { requestId: 'merge-race', revisionToken: preview.revisionToken };
  const apply = (api: typeof operator, amendedReason?: string) =>
    latePair
      ? api.applyLateDoublesPair({
          ...lateChange,
          ...intent,
          reason: amendedReason ?? lateChange.reason,
        })
      : api.applyDoublesSubstitution({
          ...change,
          ...intent,
          reason: amendedReason ?? change.reason,
        });
  const startMerge = () => mergePlayers(cluster.db, incoming!.id, survivor!.id, merger);
  const startAttendance = () => apply(operator);
  const firstWriter = first === 'merge' ? startMerge() : startAttendance();
  await Promise.race([
    lock.paused,
    firstWriter.then(() => {
      throw new Error('The first writer completed before the controlled lock point.');
    }),
  ]);
  const secondWriter = first === 'merge' ? startAttendance() : startMerge();
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
  const pair = latePair
    ? saved.entrants.find((entrant) => entrant.memberPlayerIds?.includes(incoming!.id))
    : saved.entrants.find(({ id }) => id === slot.id);
  const publicState = await caller(b, null).eventOps.snapshot({ planId });
  const { attendees } = await caller(b, nativeAdmin).eventOps.attendeeRoster({ planId });
  expect(attendees.filter(({ entryId }) => entryId === pair?.id)).toHaveLength(pair ? 2 : 0);
  const [claim] = await caller(b, participant).me.claims();
  return {
    winner,
    loser,
    profile,
    pair,
    slot,
    claim,
    saved,
    before,
    preview,
    partner,
    history: () => caller(b, nativeAdmin).eventOps.live.history({ planId, limit: 100 }),
    planner: () => caller(b, nativeAdmin).admin.eventPlanner.plan({ planId }),
    finish: () => finalizeLatePair(cluster.db, b, caller(b, nativeAdmin).eventOps, planId),
    committedSequence,
    incoming,
    survivor,
    publicPair: publicState.entrants.find(({ id }) => id === pair?.id),
    previewAgain: review,
    retryAfterRename: async () => {
      await cluster.db
        .update(players)
        .set({ displayName: 'Alias changed after response loss' })
        .where(eq(players.id, incoming!.id));
      return apply(caller(b, nativeAdmin).eventOps);
    },
    repeatDifferentIntent: () => apply(caller(b, nativeAdmin).eventOps, 'Different intent'),
    replay: () => b.replay(planId),
  };
}

async function withRace(
  workflow: Workflow,
  first: 'attendance' | 'merge',
  verify: (race: Awaited<ReturnType<typeof runRace>>) => Promise<void>,
) {
  const cluster = await postgresCluster();
  const a = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
  const b = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
  try {
    await verify(await runRace(workflow, first, cluster, a, b));
  } finally {
    await a.shutdown();
    await b.shutdown();
    await cluster.close();
  }
}

it.each(['substitution', 'late pair'] as const)(
  '%s append blocks a profile merge and recovers its exact receipt after SQL rollback',
  async (workflow) => {
    await withRace(workflow, 'attendance', async (race) => {
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
      expect(race.pair?.memberPlayerIds).toContain(race.incoming!.id);
      expect(race.claim).toMatchObject({ status: 'approved', playerId: race.incoming!.id });
      expect(race.publicPair).toMatchObject({
        memberPlayerIds: expect.arrayContaining([race.claim!.playerId]),
      });
      expect(race.committedSequence).toEqual(expect.any(Number));
      expect(await race.retryAfterRename()).toEqual({
        applied: true,
        sequence: race.committedSequence,
      });
      await expect(race.repeatDifferentIntent()).rejects.toThrow(
        /request identifier already used/i,
      );
      expect(await race.replay()).toEqual(race.saved);
      if (workflow === 'late pair') await verifyAppendedPair(race);
    });
  },
);

it.each(['substitution', 'late pair'] as const)(
  '%s waits for a profile merge and rejects the reviewed tombstoned ID',
  async (workflow) => {
    await withRace(workflow, 'merge', async (race) => {
      expect(race.winner).toMatchObject({ status: 'fulfilled' });
      expect(race.loser).toMatchObject({
        status: 'rejected',
        reason: {
          message:
            workflow === 'late pair'
              ? 'The admission changed since this preview. Review the late pair again.'
              : 'The pair changed since this preview. Review the substitution again.',
        },
      });
      expect(race.profile).toMatchObject({
        status: 'merged',
        mergedIntoPlayerId: race.survivor!.id,
      });
      expect(race.pair).toEqual(workflow === 'late pair' ? undefined : race.slot);
      expect(race.saved).toEqual(race.before);
      expect(race.claim).toMatchObject({ status: 'approved', playerId: race.survivor!.id });
      expect((await race.previewAgain()).allowed).toBe(false);
    });
  },
);

async function verifyAppendedPair(race: Awaited<ReturnType<typeof runRace>>) {
  const { before, saved, pair } = race;
  expect(race.preview).toMatchObject({
    allowed: true,
    poolIndex: 0,
    assignedTeams: 4,
    meetings: 2,
    addedMatches: 8,
    totalMatches: 20,
    finals: { championship: { before: 2, after: 3 }, consolation: { before: 2, after: 2 } },
  });
  expect(saved.baseline).toEqual(before.baseline);
  expect(saved.entrants.slice(0, before.entrants.length)).toEqual(before.entrants);
  expect(pair).toMatchObject({
    seed: 5,
    memberPlayerIds: [race.partner!.id, race.incoming!.id],
    snapshotScore: null,
  });
  const planner = await race.planner();
  expect(planner?.entries.find((entry) => entry.id === pair!.id)).toMatchObject({
    latePair: true,
    divisionSeed: 5,
    snapshotScore: null,
    currentScore: null,
  });
  expect(before.matches).toHaveLength(12);
  expect(saved.matches.slice(0, before.matches.length)).toEqual(before.matches);
  expect(saved.matches).toHaveLength(20);
  const added = saved.matches.slice(before.matches.length);
  const lastRound = Math.max(...before.matches.map(({ round }) => round));
  expect(added.map(({ round }) => round)).toEqual(
    Array.from({ length: 8 }, (_, i) => lastRound + i + 1),
  );
  for (const { id } of before.entrants) {
    const meetings = added.filter((match) => [match.player1Id, match.player2Id].includes(id));
    expect(meetings.map(({ player1Id, player2Id }) => [player1Id, player2Id])).toEqual(
      expect.arrayContaining([
        [pair!.id, id],
        [id, pair!.id],
      ]),
    );
    expect(meetings).toHaveLength(2);
  }
  expect(
    (await race.history()).entries.filter(({ eventName }) => eventName === 'DecisionRecordedV10'),
  ).toHaveLength(1);
  const finished = await race.finish();
  expect(finished.sealed.entrants.find((entrant) => entrant.id === pair!.id)).toMatchObject({
    memberPlayerIds: pair!.memberPlayerIds,
  });
  const participantIds = finished.participants
    .filter((participant) => participant.memberPlayerIds?.join() === pair!.memberPlayerIds?.join())
    .map(({ id }) => id);
  expect(participantIds.length).toBeGreaterThan(0);
  const addedIds = new Set(added.map(({ id }) => id));
  const exported = finished.exported.filter((set) =>
    addedIds.has((set.raw as { eventMatchId: string }).eventMatchId),
  );
  expect(exported).toHaveLength(8);
  expect(
    exported.every(
      (set) =>
        [set.p1ParticipantId, set.p2ParticipantId].some(
          (id) => id && participantIds.includes(id),
        ) &&
        set.p1PlayerId === null &&
        set.p2PlayerId === null &&
        !set.excludedFromRatings,
    ),
  ).toBe(true);
  const members = [race.partner!.id, race.incoming!.id] as const;
  expect(finished.fit.evidence(members).playedSets).toBeGreaterThanOrEqual(8);
}

async function finalizeLatePair(
  db: Db,
  runtime: NativeRuntime,
  eventOps: ReturnType<typeof appRouter.createCaller>['eventOps'],
  planId: string,
) {
  const group = await runtime.state(planId);
  const record = (match: Match, player1Wins: boolean) =>
    eventOps.reportScore({
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: crypto.randomUUID(),
      outcome: 'played',
      score1: player1Wins ? 2 : 0,
      score2: player1Wins ? 0 : 2,
    });
  const order = group.pools[0]!.entrantIds;
  for (const match of group.matches)
    await record(match, order.indexOf(match.player1Id!) < order.indexOf(match.player2Id!));
  const args = { planId, seedPolicy: 'pool_place_whr_v1' as const };
  const preview = await eventOps.native.preview(args);
  expect(preview.allowed).toBe(true);
  await eventOps.native.generate({ ...args, revisionToken: preview.revisionToken });
  for (;;) {
    const ready = (await runtime.state(planId)).matches.find((match) => match.status === 'ready');
    if (!ready) break;
    await record(ready, true);
  }
  await eventOps.native.finalize({ planId });
  const finished = await runtime.state(planId);
  const tournamentIds = finished.publication!.tournamentIds;
  const participants = await db
    .select()
    .from(tournamentParticipants)
    .where(inArray(tournamentParticipants.tournamentId, tournamentIds));
  const exported = await db.select().from(sets).where(inArray(sets.tournamentId, tournamentIds));
  const fit = await loadDoublesRatings(db, Date.parse('2026-10-03'));
  return { sealed: finished.result!, participants, exported, fit };
}
