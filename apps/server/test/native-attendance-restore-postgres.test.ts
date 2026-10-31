import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, nativeStream, type NativeRuntime } from '../src/tournament/runtime';
import { attendancePreview } from '../src/tournament/attendance';
import { nativeEventHistory } from '../src/tournament/history';
import { Decision, type TournamentCommand, type TournamentState } from '../src/tournament/schemas';

describe('durable reviewed restoration on isolated PostgreSQL', () => {
  let cluster: Awaited<ReturnType<typeof postgresCluster>>;
  const runtimes = new Set<NativeRuntime>();
  beforeAll(async () => {
    cluster = await postgresCluster();
  }, 30_000);
  afterAll(async () => {
    for (const live of runtimes) await live.shutdown();
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
    const live = createNativeRuntime(cluster.db, store);
    runtimes.add(live);
    return live;
  }
  function input(
    state: TournamentState,
    action: 'withdraw' | 'restore',
    reason: string,
  ): TournamentCommand {
    const playerId = state.entrants[0]!.playerId;
    return {
      kind: 'attendance',
      action,
      playerId,
      reason,
      approveRedistribution: false,
      revisionToken: attendancePreview(state, { action, playerId, reason }).revisionToken,
    };
  }
  /** Hold both real store appends on the same old head, then choose the first
   * commit. The loser must reload and recheck semantic preview/result freshness. */
  function race(planId: string, first: string, second: string) {
    let armed = false,
      arrivals = 0;
    let release!: () => void, committed!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstCommitted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const entered = new Set<string>();
    return {
      arm: () => {
        armed = true;
      },
      arrivals: () => arrivals,
      configure(store: PostgresStore) {
        const commit = store.commit.bind(store);
        store.commit = async (...args) => {
          const message = args[1].find(
            (m) => m.name === 'DecisionRecordedV3' || m.name === 'DecisionRecordedV4',
          );
          const decision = message ? Decision.parse(message.data) : undefined;
          const target =
            armed &&
            args[0] === nativeStream(planId) &&
            decision &&
            [first, second].includes(decision.requestId);
          if (!target) return commit(...args);
          if (!entered.has(decision.requestId)) {
            entered.add(decision.requestId);
            arrivals++;
            if (arrivals === 2) release();
            await both;
            if (decision.requestId === second) await firstCommitted;
          }
          try {
            return await commit(...args);
          } finally {
            if (decision.requestId === first) committed();
          }
        };
      },
    };
  }
  async function restart(a: NativeRuntime, b: NativeRuntime, planId: string) {
    const saved = await a.state(planId);
    await a.shutdown();
    runtimes.delete(a);
    await b.shutdown();
    runtimes.delete(b);
    const reopened = await runtime();
    expect(await reopened.state(planId)).toEqual(saved);
    expect(await reopened.replay(planId)).toEqual(saved);
    return reopened;
  }

  it('commits one restoration under same-head competing previews, deduplicates its request and restores exact state/history after restart', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const barrier = race(planId, 'restore-one', 'restore-two');
    const a = await runtime(barrier.configure),
      b = await runtime(barrier.configure);
    await a.lock(nativeAdmin, planId);
    let state = await a.state(planId);
    await a.command(
      nativeAdmin,
      planId,
      'withdraw-once',
      input(state, 'withdraw', 'Temporary absence'),
    );
    state = await a.state(planId);
    const restore = input(state, 'restore', 'Returned to the original entrant');
    await b.transfer(planId);
    barrier.arm();
    const [first, second] = await Promise.allSettled([
      a.command(nativeAdmin, planId, 'restore-one', restore),
      b.command(nativeAdmin, planId, 'restore-two', restore),
    ]);
    expect(barrier.arrivals()).toBe(2);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (first.status !== 'fulfilled') throw first.reason;
    const saved = await a.state(planId);
    expect(saved.entrants[0]).toMatchObject({
      playerId: state.entrants[0]!.playerId,
      availability: 'available',
      revision: 2,
    });
    const facts = await a.app.query_array({
      stream: nativeStream(planId),
      names: ['DecisionRecordedV4'],
      after: -1,
    });
    expect(facts).toHaveLength(1);
    const restored = Decision.parse(facts[0]!.data);
    expect(restored.after.entrants![0]!.availability).toBe('available');
    expect(
      restored.after
        .matches!.filter((m) => [m.player1Id, m.player2Id].includes(state.entrants[0]!.playerId))
        .every((m) => m.status === 'ready' && m.revision === 1),
    ).toBe(true);
    expect((await b.command(nativeAdmin, planId, 'restore-one', restore)).receipt).toEqual(
      first.value.receipt,
    );
    expect((await a.state(planId)).sequence).toBe(saved.sequence);
    const reopened = await restart(a, b, planId);
    const history = await nativeEventHistory(reopened, cluster.db, planId);
    const entries = history.entries.filter((entry) => entry.title === 'Entrant restored');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventName: 'DecisionRecordedV4',
      actor: nativeAdmin.name,
      source: 'operator',
    });
    expect(entries[0]!.summary).toContain('Returned to the original entrant');
  });

  for (const first of ['restore', 'forfeit'])
    it(`keeps reviewed availability and recorded results coherent when ${first} wins a restore/forfeit race`, async () => {
      const planId = await seedNativeDraft(cluster.db);
      const barrier = race(planId, first, first === 'restore' ? 'forfeit' : 'restore');
      const a = await runtime(barrier.configure),
        b = await runtime(barrier.configure);
      await a.lock(nativeAdmin, planId);
      let state = await a.state(planId);
      await a.command(
        nativeAdmin,
        planId,
        'withdraw',
        input(state, 'withdraw', 'Temporarily away'),
      );
      state = await a.state(planId);
      const target = state.entrants[0]!.playerId;
      const match = state.matches.find((m) => [m.player1Id, m.player2Id].includes(target))!;
      const restore = input(state, 'restore', 'Returned before the next set');
      const forfeit: TournamentCommand = {
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        score1: null,
        score2: null,
        outcome: 'forfeit',
        winnerId: match.player1Id === target ? match.player2Id! : match.player1Id!,
      };
      await b.transfer(planId);
      barrier.arm();
      const [restored, scored] = await Promise.allSettled([
        a.command(nativeAdmin, planId, 'restore', restore),
        b.command(nativeAdmin, planId, 'forfeit', forfeit),
      ]);
      expect(barrier.arrivals()).toBe(2);
      expect(restored.status).toBe(first === 'restore' ? 'fulfilled' : 'rejected');
      expect(scored.status).toBe(first === 'forfeit' ? 'fulfilled' : 'rejected');
      state = await a.state(planId);
      const decided = structuredClone(state.matches.find((m) => m.id === match.id)!);
      expect(decided.outcome).toBe(first === 'forfeit' ? 'forfeit' : null);
      expect(state.entrants[0]!.availability).toBe(first === 'restore' ? 'available' : 'withdrawn');
      if (first === 'forfeit')
        await a.command(
          nativeAdmin,
          planId,
          'reviewed-after-forfeit',
          input(state, 'restore', 'Restored attendance; recorded forfeit retained'),
        );
      const saved = await a.state(planId);
      const finalMatch = saved.matches.find((m) => m.id === match.id)!;
      expect(finalMatch).toEqual(decided);
      expect(saved.entrants[0]!.availability).toBe('available');
      expect(finalMatch.player1Id).toBe(match.player1Id);
      expect(finalMatch.player2Id).toBe(match.player2Id);
      await restart(a, b, planId);
    });
});
