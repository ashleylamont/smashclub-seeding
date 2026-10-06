import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { ConcurrencyError } from '@rotorsoft/act';
import { and, eq, sql } from 'drizzle-orm';
import {
  eventMatches,
  eventPlans,
  nativeLiveHandoffs,
  nativeResultPublications,
  nativeRatingIntents,
  tournaments,
} from '@smashclub/db';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft, envelope } from './helpers/nativeLiveFixture';
import { stageNativeBaseline } from '../src/tournament/baseline';
import { NativeTournament } from '../src/tournament/aggregate';
import { createNativeRuntime, nativeStream, type NativeRuntime } from '../src/tournament/runtime';
import { processNativeRatingIntents, publishNativeResult } from '../src/tournament/publication';
import type { TournamentCommand, TournamentResult } from '../src/tournament/schemas';

describe('native Act-PG integration on isolated PostgreSQL', () => {
  let cluster: Awaited<ReturnType<typeof postgresCluster>>;
  const runtimes = new Set<NativeRuntime>();
  beforeAll(async () => {
    cluster = await postgresCluster();
  }, 30_000);
  afterAll(async () => {
    for (const runtime of runtimes) await runtime.shutdown();
    await cluster?.close();
  });
  async function runtime(fault?: Parameters<typeof publishNativeResult>[2]) {
    const store = new PostgresStore({
      connectionString: cluster.connectionString,
      schema: 'native_act',
      table: 'events',
    });
    await store.seed();
    const value = createNativeRuntime(cluster.db, store, fault);
    runtimes.add(value);
    return value;
  }
  async function state(runtime: NativeRuntime, planId: string) {
    return (await runtime.app.load(NativeTournament, nativeStream(planId))).state.current[0];
  }
  const command = (
    runtime: NativeRuntime,
    planId: string,
    input: TournamentCommand,
    requestId: string = crypto.randomUUID(),
  ) => runtime.command(nativeAdmin, planId, requestId, input);
  async function completed(runtime: NativeRuntime, planId: string) {
    for (const match of (await state(runtime, planId)).matches)
      await command(runtime, planId, {
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    for (const pool of (await state(runtime, planId)).pools) {
      const current = await state(runtime, planId);
      await command(runtime, planId, {
        kind: 'placements',
        poolId: pool.id,
        order: pool.entrantIds,
        expectedRevision: pool.revision,
        matchRevisions: Object.fromEntries(
          current.matches.filter((m) => m.poolId === pool.id).map((m) => [m.id, m.revision]),
        ),
      });
    }
    await command(runtime, planId, { kind: 'drawFinals' });
    for (;;) {
      const match = (await state(runtime, planId)).matches.find((m) => m.status === 'ready');
      if (!match) break;
      await command(runtime, planId, {
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    }
  }
  async function awaitPublication(runtime: NativeRuntime, planId: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await runtime.recover();
      if ((await state(runtime, planId)).publication) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Publication did not recover before deadline');
  }
  async function countPublications(planId: string) {
    return cluster.db
      .select()
      .from(nativeResultPublications)
      .where(eq(nativeResultPublications.eventPlanId, planId));
  }

  it('enforces expected stream versions across independent caches and deduplicates concurrent requests', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const a = await runtime();
    const b = await runtime();
    await a.lock(nativeAdmin, planId);
    await b.transfer(planId);
    const [one, two] = await Promise.all([
      a.app.load(NativeTournament, nativeStream(planId)),
      b.app.load(NativeTournament, nativeStream(planId)),
    ]);
    expect(one.version).toBe(two.version);
    const attempts = await Promise.allSettled([
      a.app.do(
        'ExecuteNativeCommand',
        { stream: nativeStream(planId), actor: { ...nativeAdmin }, expectedVersion: one.version },
        envelope({ kind: 'unlock' }),
      ),
      b.app.do(
        'ExecuteNativeCommand',
        { stream: nativeStream(planId), actor: { ...nativeAdmin }, expectedVersion: two.version },
        envelope({ kind: 'unlock' }),
      ),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejection = attempts.find((r) => r.status === 'rejected');
    expect(rejection?.status === 'rejected' && rejection.reason).toBeInstanceOf(ConcurrencyError);
    await command(a, planId, { kind: 'relock' });
    const match = (await state(a, planId)).matches[0]!;
    const score: TournamentCommand = {
      kind: 'score',
      matchId: match.id,
      expectedRevision: match.revision,
      score1: 2,
      score2: 0,
      outcome: 'played',
    };
    const [first, second] = await Promise.all([
      command(a, planId, score, 'duplicate'),
      command(b, planId, score, 'duplicate'),
    ]);
    expect(first.receipt).toEqual(second.receipt);
    const current = await state(b, planId);
    expect(current.matches[0]!.revision).toBe(1);
    expect(await a.replay(planId)).toEqual(current);
    await expect(command(b, planId, { ...score, score2: 1 }, 'duplicate')).rejects.toThrow(
      /identifier/,
    );
  });

  it('serializes resource contention while accepting unrelated and agreeing concurrent player reports', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const a = await runtime();
    const b = await runtime();
    await a.lock(nativeAdmin, planId);
    await command(a, planId, {
      kind: 'resources',
      capacity: 1,
      stations: [],
      expectedResourceRevision: 0,
    });
    const initial = await state(a, planId);
    const upper = initial.matches.find((m) => m.division === 'upper')!;
    const lower = initial.matches.find((m) => m.division === 'lower')!;
    const dispatches = await Promise.allSettled(
      [upper, lower].map((m, i) =>
        command(i ? b : a, planId, {
          kind: 'dispatch',
          matchId: m.id,
          stationId: null,
          expectedRevision: m.revision,
          expectedResourceRevision: 1,
        }),
      ),
    );
    expect(dispatches.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await state(a, planId)).matches.filter((m) => m.status === 'playing')).toHaveLength(1);
    const score: TournamentCommand = {
      kind: 'score',
      matchId: upper.id,
      expectedRevision: upper.revision,
      score1: 2,
      score2: 0,
      outcome: 'played',
    };
    const p1 = { ...nativeAdmin, id: 'player-one', role: 'user' as const };
    const p2 = { ...nativeAdmin, id: 'player-two', role: 'user' as const };
    await Promise.all([
      a.command(p1, planId, 'agree-a', score),
      b.command(p2, planId, 'agree-b', score),
    ]);
    await b.command({ ...p2, id: 'player-three' }, planId, 'dispute', {
      ...score,
      score1: 0,
      score2: 2,
    });
    const current = await state(a, planId);
    expect(current.matches.find((m) => m.id === upper.id)!.revision).toBe(1);
    expect(current.reports.filter((r) => r.status === 'approved')).toHaveLength(2);
    expect(current.reports.filter((r) => r.isDispute)).toHaveLength(1);
    expect(await a.replay(planId)).toEqual(current);
  });

  it('freezes baseline ownership against a legacy SQL writer waiting behind adoption', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const blocker = await cluster.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM event_plans WHERE id=$1 FOR UPDATE', [planId]);
    // Both independent connections wait for the same draft lock. Adoption gets
    // queued first; the writer must recheck ownership after obtaining its lock.
    const adoption = stageNativeBaseline(cluster.db, nativeAdmin, planId);
    for (let n = 0; n < 100; n++) {
      const { rows } = await blocker.query(
        "select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and pid<>pg_backend_pid()",
      );
      if (rows[0].n) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const writer = cluster.db
      .update(eventPlans)
      .set({ name: 'stale draft overwrite' })
      .where(eq(eventPlans.id, planId));
    const writerResult = Promise.resolve(writer).then(
      () => 'committed',
      () => 'rejected',
    );
    await blocker.query('COMMIT');
    blocker.release();
    await adoption;
    expect(await writerResult).toBe('rejected');
    expect(
      await cluster.db
        .select()
        .from(nativeLiveHandoffs)
        .where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toHaveLength(1);
  });

  it('retains snapshots/history and recovers durable publication after SQL commit and process restart', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const a = await runtime(async (phase) => {
      if (phase === 'afterCommit') throw new Error('simulated publication acknowledgement crash');
    });
    await a.lock(nativeAdmin, planId);
    for (let i = 0; i < 22; i++)
      await command(a, planId, {
        kind: 'resources',
        capacity: 2,
        stations: [],
        expectedResourceRevision: (await state(a, planId)).settings.resourceRevision,
      });
    await completed(a, planId);
    const response = await command(a, planId, { kind: 'finalize' }, 'finalize-once');
    expect(response.publicationStatus).toBe('pending');
    await a.drainReactions();
    expect(await countPublications(planId)).toHaveLength(1);
    const result = (await state(a, planId)).result!;
    expect((await state(a, planId)).publication).toBeNull();
    await a.shutdown();
    runtimes.delete(a);
    const b = await runtime();
    await awaitPublication(b, planId);
    const live = await state(b, planId);
    expect(live.matches.filter((m) => m.parent1Id)).toHaveLength(4);
    expect(
      live.matches
        .filter((m) => m.parent1Id)
        .every((m) => m.status === 'complete' && m.player1Id && m.player2Id),
    ).toBe(true);
    expect(live.result).toEqual(result);
    expect(live.publication!.tournamentIds).toHaveLength(4);
    expect(await b.replay(planId)).toEqual(live);
    const raw = await cluster.pool.query(
      'select name, count(*)::int as n from native_act.events where stream=$1 group by name',
      [nativeStream(planId)],
    );
    expect(raw.rows.find((r) => r.name === '__snapshot__')?.n).toBeGreaterThan(0);
    expect(raw.rows.find((r) => r.name === 'BaselineCapturedV1')?.n).toBe(1);
    expect(raw.rows.find((r) => r.name === 'ResultsSealedV1')?.n).toBe(1);
    expect(raw.rows.find((r) => r.name === 'PublicationRecordedV1')?.n).toBe(1);
    expect(await countPublications(planId)).toHaveLength(1);
    await expect(command(b, planId, { kind: 'unlock' })).rejects.toThrow(/sealed/);
    expect((await command(b, planId, { kind: 'finalize' }, 'finalize-once')).receipt).toEqual(
      response.receipt,
    );
    const intents = await cluster.db
      .select()
      .from(nativeRatingIntents)
      .where(eq(nativeRatingIntents.resultId, result.id));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.completedAt).toBeNull();
    await processNativeRatingIntents(cluster.db);
    expect(
      (
        await cluster.db
          .select()
          .from(nativeRatingIntents)
          .where(eq(nativeRatingIntents.resultId, result.id))
      )[0]!.completedAt,
    ).not.toBeNull();
  });

  it('rolls back failed publication SQL and deduplicates publication from two independent connections', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const a = await runtime();
    await a.lock(nativeAdmin, planId);
    await completed(a, planId);
    // Seal a standalone persisted decision, but invoke the SQL handoff directly
    // to control its failure boundary independently of reaction scheduling.
    const current = await state(a, planId);
    const result: TournamentResult = {
      version: 1,
      id: crypto.randomUUID(),
      planId,
      revision: 1,
      name: current.baseline!.name,
      eventDate: current.baseline!.eventDate,
      sealedAt: Date.now(),
      replacesResultId: null,
      replacementReason: null,
      entrants: current.entrants,
      brackets: current.brackets,
      matches: current.matches,
    };
    await expect(
      publishNativeResult(cluster.db, result, async (phase, tx) => {
        if (phase === 'beforeReceipt') await tx!.execute(sql`select 1/0`);
      }),
    ).rejects.toThrow(/select 1\/0/);
    expect(await countPublications(planId)).toHaveLength(0);
    const receipts = await Promise.all([
      publishNativeResult(cluster.db, result),
      publishNativeResult(cluster.db, result),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await countPublications(planId)).toHaveLength(1);
    expect(
      await cluster.db
        .select()
        .from(tournaments)
        .where(
          and(
            eq(tournaments.provider, 'native'),
            sql`${tournaments.raw}->>'resultId' = ${result.id}`,
          ),
        ),
    ).toHaveLength(4);
    await expect(
      cluster.db
        .update(eventMatches)
        .set({ winnerId: result.entrants[0]!.playerId })
        .where(eq(eventMatches.eventPlanId, planId)),
    ).rejects.toThrow(/update "event_matches"/);
  });
});
