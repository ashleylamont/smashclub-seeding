import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { eq } from 'drizzle-orm';
import {
  eventPlans,
  eventPlanEntries,
  players,
  user,
  nativeResultPublications,
} from '@smashclub/db';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { applyPlanRetirement } from '../src/event-planner/retirement';
import { publishNativeResult } from '../src/tournament/publication';
import { nativeHistory } from '../src/events/nativeHistory';
import { loadSinglesHistory } from '../src/recompute/inputs';

describe('durable plan recovery with independent PostgreSQL runtimes', () => {
  let cluster: Awaited<ReturnType<typeof postgresCluster>>;
  const runtimes = new Set<NativeRuntime>();
  beforeAll(async () => {
    cluster = await postgresCluster();
    await cluster.db.insert(user).values(nativeAdmin);
  }, 30_000);
  afterAll(async () => {
    for (const runtime of runtimes) await runtime.shutdown();
    await cluster?.close();
  });
  async function runtime() {
    const store = new PostgresStore({
      connectionString: cluster.connectionString,
      schema: 'native_act',
      table: 'events',
    });
    await store.seed();
    const value = createNativeRuntime(cluster.db, store);
    runtimes.add(value);
    return value;
  }
  async function locked(a: NativeRuntime) {
    const members = await cluster.db
      .insert(players)
      .values([
        { canonicalName: `A ${crypto.randomUUID()}` },
        { canonicalName: `B ${crypto.randomUUID()}` },
      ])
      .returning();
    const [plan] = await cluster.db
      .insert(eventPlans)
      .values({
        name: 'Durable recovery rehearsal',
        eventDate: new Date('2026-10-01'),
        bracketMode: 'native',
        structure: 'round_robin',
        status: 'pools_ready',
      })
      .returning();
    await cluster.db.insert(eventPlanEntries).values(
      members.map((p, i) => ({
        eventPlanId: plan!.id,
        sourceLineNumber: i + 1,
        rawInput: p.canonicalName,
        cleanedName: p.canonicalName,
        playerId: p.id,
        assignedDivision: 'upper' as const,
        divisionSeed: i + 1,
        snapshotRank: i + 1,
        snapshotScore: 1200 - i,
        resolutionMethod: 'manual' as const,
      })),
    );
    await a.lock(nativeAdmin, plan!.id);
    return plan!.id;
  }
  it('serializes a reset against a score, reconstructs after restart, and rejects old-cache commands', async () => {
    const a = await runtime(),
      b = await runtime();
    const planId = await locked(a);
    await b.transfer(planId);
    const state = await a.state(planId),
      match = state.matches[0]!,
      replacementPlanId = crypto.randomUUID();
    const results = await Promise.allSettled([
      a.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'retire',
        operation: 'reset',
        replacementPlanId,
        withdrawResults: false,
        reason: 'Concurrent reset',
        expectedSequence: state.sequence,
      }),
      b.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        score1: 2,
        score2: 0,
        outcome: 'played',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const settled = await a.state(planId);
    if (!settled.retirement)
      await a.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'retire',
        operation: 'reset',
        replacementPlanId,
        withdrawResults: false,
        reason: 'Reviewed after the score',
        expectedSequence: settled.sequence,
      });
    await a.shutdown();
    runtimes.delete(a);
    const restarted = await runtime();
    await restarted.recover();
    await restarted.recover();
    expect(
      await cluster.db.select().from(eventPlans).where(eq(eventPlans.id, replacementPlanId)),
    ).toHaveLength(1);
    expect(
      (await cluster.db.select().from(eventPlans).where(eq(eventPlans.id, planId)))[0]!.deletedAt,
    ).not.toBeNull();
    expect(await restarted.replay(planId)).toEqual(await restarted.state(planId));
    await expect(
      b.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'score',
        matchId: match.id,
        expectedRevision: 0,
        score1: 0,
        score2: 2,
        outcome: 'played',
      }),
    ).rejects.toThrow(/sealed/);
    await expect(
      cluster.db
        .update(eventPlans)
        .set({ name: 'Stale SQL edit' })
        .where(eq(eventPlans.id, planId)),
    ).rejects.toThrow(/update/);
  });
  it.each(['publication first', 'withdrawal first'])(
    'keeps results withdrawn when %s',
    async (order) => {
      const a = await runtime(),
        planId = await locked(a);
      let state = await a.state(planId);
      await a.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'score',
        matchId: state.matches[0]!.id,
        expectedRevision: 0,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
      state = await a.state(planId);
      await a.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'placements',
        poolId: state.pools[0]!.id,
        order: state.pools[0]!.entrantIds,
        expectedRevision: state.pools[0]!.revision,
        matchRevisions: Object.fromEntries(state.matches.map((m) => [m.id, m.revision])),
      });
      await a.command(nativeAdmin, planId, crypto.randomUUID(), { kind: 'finalize' });
      state = await a.state(planId);
      const result = state.result!;
      await a.command(nativeAdmin, planId, crypto.randomUUID(), {
        kind: 'retire',
        operation: 'delete',
        replacementPlanId: null,
        withdrawResults: true,
        reason: 'Withdraw before delayed publication',
        expectedSequence: state.sequence,
      });
      const retired = await a.state(planId);
      if (order === 'publication first') {
        let entered!: () => void, release!: () => void, failed!: (reason: unknown) => void;
        const publicationEntered = new Promise<void>((resolve, reject) => {
          entered = resolve;
          failed = reject;
        });
        const finishPublication = new Promise<void>((resolve) => {
          release = resolve;
        });
        const publication = publishNativeResult(cluster.db, result, async (phase) => {
          if (phase === 'beforeReceipt') {
            entered();
            await finishPublication;
          }
        });
        void publication.catch(failed);
        await publicationEntered;
        const withdrawal = applyPlanRetirement(
          cluster.db,
          planId,
          retired.retirement!,
          retired.entrants,
        );
        release();
        await Promise.all([publication, withdrawal]);
      } else {
        await applyPlanRetirement(cluster.db, planId, retired.retirement!, retired.entrants);
        await publishNativeResult(cluster.db, result);
      }
      await a.recover();
      const history = await nativeHistory(cluster.db);
      const receipts = await cluster.db
        .select()
        .from(nativeResultPublications)
        .where(eq(nativeResultPublications.eventPlanId, planId));
      expect(receipts).toHaveLength(order === 'publication first' ? 1 : 0);
      for (const id of receipts.flatMap((p) => p.tournamentIds))
        expect(history.withdrawn.has(id)).toBe(true);
      const historySets = (await loadSinglesHistory(cluster.db)).engineSets;
      const publishedIds = new Set(receipts.flatMap((p) => p.tournamentIds));
      expect((await publishNativeResult(cluster.db, result)).tournamentIds).toEqual([
        ...publishedIds,
      ]);
      expect(historySets.some((s) => publishedIds.has(s.tournamentId))).toBe(false);
      expect((await a.state(planId)).lifecycle).toBe('cancelled');
      expect(await a.replay(planId)).toEqual(await a.state(planId));
    },
  );
});
