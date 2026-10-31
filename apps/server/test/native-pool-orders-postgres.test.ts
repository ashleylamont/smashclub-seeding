import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, nativeStream, type NativeRuntime } from '../src/tournament/runtime';
import { nativeEventHistory } from '../src/tournament/history';
import { eventView, planView } from '../src/tournament/views';
import { Decision, type TournamentCommand, type TournamentState } from '../src/tournament/schemas';

describe('automatic pool-order facts on isolated PostgreSQL', () => {
  let cluster: Awaited<ReturnType<typeof postgresCluster>>;
  const runtimes = new Set<NativeRuntime>();
  beforeAll(async () => {
    cluster = await postgresCluster();
  }, 30_000);
  afterAll(async () => {
    for (const runtime of runtimes) await runtime.shutdown();
    await cluster?.close();
  });
  async function runtime(configure?: (store: PostgresStore) => void) {
    const store = new PostgresStore({
      connectionString: cluster.connectionString,
      schema: 'native_act',
      table: 'events',
    });
    await store.seed();
    configure?.(store);
    const value = createNativeRuntime(cluster.db, store);
    runtimes.add(value);
    return value;
  }
  function score(state: TournamentState, id: string): TournamentCommand {
    const m = state.matches.find((m) => m.id === id)!;
    const order = state.pools.find((p) => p.id === m.poolId)!.entrantIds;
    const first = order.indexOf(m.player1Id!) < order.indexOf(m.player2Id!);
    return {
      kind: 'score',
      matchId: id,
      expectedRevision: m.revision,
      score1: first ? 2 : 0,
      score2: first ? 0 : 2,
      outcome: 'played',
    };
  }

  it('serializes independent last results, persists one automatic placement, and preserves its receipt and proof across restart', async () => {
    const planId = await seedNativeDraft(cluster.db);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const targets = new Set<string>();
    const synchronize = (store: PostgresStore) => {
      const commit = store.commit.bind(store);
      store.commit = async (...args) => {
        if (
          args[0] === nativeStream(planId) &&
          args[1].some((message) => {
            if (message.name !== 'DecisionRecordedV2') return false;
            const command = Decision.parse(message.data).command;
            return command.kind === 'score' && targets.has(command.matchId);
          })
        ) {
          arrivals++;
          if (arrivals === 2) release();
          await barrier;
        }
        return commit(...args);
      };
    };
    const a = await runtime(synchronize);
    const b = await runtime(synchronize);
    await a.lock(nativeAdmin, planId);
    let state = await a.state(planId);
    expect(state.settings.poolOrderPolicy).toBe('unique_set_wins_v1');
    const pool = state.pools[0]!;
    const matches = state.matches.filter((m) => m.poolId === pool.id);
    for (const m of matches.slice(0, -2))
      await a.command(nativeAdmin, planId, m.id, score(state, m.id));
    state = await a.state(planId);
    await b.transfer(planId);
    const penultimate = score(state, matches.at(-2)!.id);
    const last = score(state, matches.at(-1)!.id);
    targets.add(matches.at(-2)!.id);
    targets.add(matches.at(-1)!.id);
    const results = await Promise.allSettled([
      a.command(nativeAdmin, planId, 'penultimate', penultimate),
      b.command(nativeAdmin, planId, 'last', last),
    ]);
    // Both actions decide against the same stream head before either PG commit.
    // The losing append must reload and decide the second result and pool order.
    expect(arrivals).toBe(3);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const saved = await a.state(planId);
    expect(saved.pools[0]!.order).toEqual(pool.entrantIds);
    expect(saved.pools[0]!.orderDecision!.source).toBe('automatic');
    const events = await a.app.query_array({
      stream: nativeStream(planId),
      names: ['DecisionRecordedV2'],
      after: -1,
    });
    const placementEvents = events
      .map((e) => Decision.parse(e.data))
      .filter((d) => d.after.pools?.some((p) => p.orderDecision));
    expect(placementEvents).toHaveLength(1);
    expect(
      placementEvents[0]!.after
        .matches!.filter((m) => m.poolId === pool.id)
        .every((m) => m.status === 'complete'),
    ).toBe(true);
    expect(placementEvents[0]!.after.pools![0]!.orderDecision!.commandId).toBe(
      placementEvents[0]!.commandId,
    );
    const lastResult = results[1]!;
    if (lastResult.status !== 'fulfilled') throw lastResult.reason;
    const originalReceipt = lastResult.value.receipt;
    expect((await a.command(nativeAdmin, planId, 'last', last)).receipt).toEqual(originalReceipt);
    expect((await a.state(planId)).sequence).toBe(saved.sequence);
    await a.shutdown();
    runtimes.delete(a);
    await b.shutdown();
    runtimes.delete(b);
    const restarted = await runtime();
    expect(await restarted.state(planId)).toEqual(saved);
    expect(await restarted.replay(planId)).toEqual(saved);
    expect((await restarted.command(nativeAdmin, planId, 'last', last)).receipt).toEqual(
      originalReceipt,
    );
    expect(
      (await nativeEventHistory(restarted, cluster.db, planId)).entries.some(
        (e) => e.eventName === 'DecisionRecordedV2',
      ),
    ).toBe(true);

    const publicSnapshot = await restarted.snapshot(planId);
    expect(publicSnapshot.pools[0]!.orderStatus.status).toBe('automatic');
    expect(publicSnapshot.pools[0]).not.toHaveProperty('orderDecision');
    expect(publicSnapshot.reports).toEqual([]);
    const publicView = await eventView(cluster.db, saved);
    expect(publicView.poolOrders![0]!.status).toBe('automatic');
    expect(
      publicView.placements
        .filter((p) => p.poolIndex === pool.index && p.division === pool.division)
        .every((p) => p.source === 'automatic'),
    ).toBe(true);
    expect(publicView.poolOrders![0]).not.toHaveProperty('commandId');
    const planner = await planView(cluster.db, saved);
    const plannerPool = planner.divisions
      .find((d) => d.division === pool.division)!
      .pools.find((p) => p.poolIndex === pool.index)!;
    expect(plannerPool.orderStatus!.status).toBe('automatic');
    expect(plannerPool.members.map((m) => m.place).sort()).toEqual([1, 2, 3, 4]);
  });

  it('rejects a stale manual worksheet after the automatic last-result placement', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const live = await runtime();
    await live.lock(nativeAdmin, planId);
    const before = await live.state(planId);
    const pool = before.pools[0]!;
    for (const m of before.matches.filter((m) => m.poolId === pool.id))
      await live.command(nativeAdmin, planId, m.id, score(before, m.id));
    const saved = await live.state(planId);
    await expect(
      live.command(nativeAdmin, planId, 'stale-order', {
        kind: 'placements',
        poolId: pool.id,
        order: [...pool.entrantIds].reverse(),
        expectedRevision: pool.revision,
        matchRevisions: Object.fromEntries(
          before.matches.filter((m) => m.poolId === pool.id).map((m) => [m.id, m.revision]),
        ),
      }),
    ).rejects.toThrow(/placements changed/);
    expect(await live.state(planId)).toEqual(saved);
  });
});
