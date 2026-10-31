import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, nativeStream, type NativeRuntime } from '../src/tournament/runtime';
import { nativeEventHistory } from '../src/tournament/history';
import { finalsToken } from '../src/tournament/operations';
import { Decision, type TournamentCommand, type TournamentState } from '../src/tournament/schemas';

describe('rolling qualifier decisions on isolated PostgreSQL', () => {
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
  function score(state: TournamentState, id: string): TournamentCommand {
    const match = state.matches.find((m) => m.id === id)!;
    const pool = state.pools.find((p) => p.id === match.poolId)!;
    const first =
      pool.entrantIds.indexOf(match.player1Id!) < pool.entrantIds.indexOf(match.player2Id!);
    return {
      kind: 'score',
      matchId: id,
      expectedRevision: match.revision,
      score1: first ? 2 : 0,
      score2: first ? 0 : 2,
      outcome: 'played',
    };
  }
  async function complete(live: NativeRuntime, planId: string, poolId: string, except?: string) {
    const state = await live.state(planId);
    for (const m of state.matches.filter((m) => m.poolId === poolId && m.id !== except))
      await live.command(nativeAdmin, planId, m.id, score(state, m.id));
  }
  /** Both decisions reach the same old stream head; control real append ordering
   * so each side of a semantic race is reproducible without sleeps or mock storage. */
  function orderedRace(planId: string, first: string, second: string) {
    let armed = false,
      arrivals = 0;
    let releaseBoth!: () => void, releaseSecond!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const firstCommitted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const attempts = new Map<string, number>();
    return {
      arm: () => {
        armed = true;
      },
      attempts,
      arrivals: () => arrivals,
      configure(store: PostgresStore) {
        const commit = store.commit.bind(store);
        store.commit = async (...args) => {
          const message = args[1].find((m) => m.name === 'DecisionRecordedV3');
          const decision = message ? Decision.parse(message.data) : undefined;
          const target =
            armed &&
            args[0] === nativeStream(planId) &&
            decision &&
            [first, second].includes(decision.requestId);
          if (!target) return commit(...args);
          const count = (attempts.get(decision.requestId) ?? 0) + 1;
          attempts.set(decision.requestId, count);
          if (count === 1) {
            arrivals++;
            if (arrivals === 2) releaseBoth();
            await both;
            if (decision.requestId === second) await firstCommitted;
          }
          try {
            return await commit(...args);
          } finally {
            if (decision.requestId === first) releaseSecond();
          }
        };
      },
    };
  }

  it('atomically resolves a reserved field after a same-head last-score/create race and replays the exact choices after restart', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const race = orderedRace(planId, 'reserve-field', 'last-pool-result');
    const a = await runtime(race.configure),
      b = await runtime(race.configure);
    await a.lock(nativeAdmin, planId);
    let state = await a.state(planId);
    const upper = state.pools.filter((p) => p.division === 'upper');
    await complete(a, planId, upper[0]!.id);
    const last = state.matches.findLast((m) => m.poolId === upper[1]!.id)!;
    await complete(a, planId, upper[1]!.id, last.id);
    state = await a.state(planId);
    await b.transfer(planId);
    const draw: TournamentCommand = { kind: 'drawFinals', revisionToken: finalsToken(state) };
    const result = score(state, last.id);
    race.arm();
    const [created, recorded] = await Promise.all([
      a.command(nativeAdmin, planId, 'reserve-field', draw),
      b.command(nativeAdmin, planId, 'last-pool-result', result),
    ]);
    expect(race.arrivals()).toBe(2);
    expect(race.attempts.get('last-pool-result')).toBe(2);
    const saved = await a.state(planId);
    expect(saved.brackets).toHaveLength(4);
    expect(saved.pools.every((p) => p.qualifierRoster?.length === 4)).toBe(true);
    expect(
      saved.matches.some((m) => m.bracketId && m.division === 'upper' && m.status === 'ready'),
    ).toBe(true);
    expect(
      saved.matches
        .filter((m) => m.bracketId && m.division === 'lower')
        .every((m) => m.status === 'blocked' && m.outcome === null && !m.winnerId),
    ).toBe(true);
    const facts = (
      await a.app.query_array({
        stream: nativeStream(planId),
        names: ['DecisionRecordedV3'],
        after: -1,
      })
    ).map((e) => Decision.parse(e.data));
    expect(facts.filter((d) => d.kind === 'drawFinals')).toHaveLength(1);
    const resolution = facts.find((d) => d.requestId === 'last-pool-result')!;
    expect(resolution.after.pools!.find((p) => p.id === upper[1]!.id)!.orderDecision!.source).toBe(
      'automatic',
    );
    expect(
      resolution.after
        .brackets!.filter((bracket) => bracket.division === 'upper')
        .every((bracket) => bracket.qualifierSlots!.every((s) => s.status === 'resolved')),
    ).toBe(true);
    expect(resolution.after.matches!.find((m) => m.id === last.id)!.status).toBe('complete');
    expect((await a.command(nativeAdmin, planId, 'reserve-field', draw)).receipt).toEqual(
      created.receipt,
    );
    expect((await b.command(nativeAdmin, planId, 'last-pool-result', result)).receipt).toEqual(
      recorded.receipt,
    );
    expect((await a.state(planId)).sequence).toBe(saved.sequence);
    await a.shutdown();
    runtimes.delete(a);
    await b.shutdown();
    runtimes.delete(b);
    const restarted = await runtime();
    expect(await restarted.state(planId)).toEqual(saved);
    expect(await restarted.replay(planId)).toEqual(saved);
    const snapshot = await restarted.snapshot(planId);
    expect(
      snapshot.nativeBrackets.some((bracket) =>
        bracket.qualifierSlots?.some((q) => q.status === 'pending'),
      ),
    ).toBe(true);
    expect(snapshot.reports).toEqual([]);
    expect(snapshot.pools.every((p) => !('orderDecision' in p))).toBe(true);
    expect(
      (await nativeEventHistory(restarted, cluster.db, planId)).entries.some(
        (entry) => entry.eventName === 'DecisionRecordedV3',
      ),
    ).toBe(true);
    expect(saved.result).toBeNull();
    expect(saved.publication).toBeNull();
  });

  for (const first of ['call-final', 'submit-dispute'])
    it(`keeps the report and actual identities coherent when ${first} wins a same-head call/review race`, async () => {
      const planId = await seedNativeDraft(cluster.db);
      const second = first === 'call-final' ? 'submit-dispute' : 'call-final';
      const race = orderedRace(planId, first, second);
      const a = await runtime(race.configure),
        b = await runtime(race.configure);
      await a.lock(nativeAdmin, planId);
      let state = await a.state(planId);
      for (const pool of state.pools.filter((p) => p.division === 'upper'))
        await complete(a, planId, pool.id);
      state = await a.state(planId);
      await a.command(nativeAdmin, planId, 'shared-capacity', {
        kind: 'configureDispatch',
        capacity: 1,
        reservedStationIds: [],
        expectedResourceRevision: state.settings.resourceRevision,
      });
      state = await a.state(planId);
      await a.command(nativeAdmin, planId, 'create-finals', {
        kind: 'drawFinals',
        revisionToken: finalsToken(state),
      });
      state = await a.state(planId);
      const final = state.matches.find(
        (m) => m.bracketId && m.division === 'upper' && m.stage === 'main' && m.status === 'ready',
      )!;
      const source = state.matches.find((m) => m.poolId === final.player1Qualifier!.poolId)!;
      const dispute: TournamentCommand = {
        kind: 'score',
        matchId: source.id,
        expectedRevision: source.revision,
        score1: source.score1 === 2 ? 0 : 2,
        score2: source.score2 === 2 ? 0 : 2,
        outcome: 'played',
      };
      const call: TournamentCommand = {
        kind: 'dispatch',
        matchId: final.id,
        stationId: null,
        callOnly: true,
        expectedRevision: final.revision,
        expectedResourceRevision: state.settings.resourceRevision,
      };
      await b.transfer(planId);
      race.arm();
      const [called, reported] = await Promise.allSettled([
        a.command(nativeAdmin, planId, 'call-final', call),
        b.command(
          { ...nativeAdmin, id: `attendee-${first}`, role: 'user' },
          planId,
          'submit-dispute',
          dispute,
        ),
      ]);
      expect(race.arrivals()).toBe(2);
      expect(reported.status).toBe('fulfilled');
      state = await a.state(planId);
      const held = state.matches.find((m) => m.id === final.id)!;
      const pending = state.reports.find((r) => r.requestId === 'submit-dispute')!;
      expect(pending.status).toBe('pending');
      expect(held.qualificationBlocks!.some((s) => s.status === 'review_pending')).toBe(true);
      const callWon = first === 'call-final';
      expect(called.status).toBe(callWon ? 'fulfilled' : 'rejected');
      expect(held.status).toBe(callWon ? 'playing' : 'blocked');
      expect([held.player1Id, held.player2Id]).toEqual(
        callWon ? [final.player1Id, final.player2Id] : [null, final.player2Id],
      );
      expect(held.outcome).toBeNull();
      expect(held.winnerId).toBeNull();
      const protection = callWon
        ? await a.command(nativeAdmin, planId, 'protected-correction', dispute).then(
            () => null,
            (error: Error) => error,
          )
        : null;
      expect(protection?.message ?? '').toMatch(callWon ? /Finals already use/ : /^$/);
      await a.command(nativeAdmin, planId, 'reject-dispute', {
        kind: 'review',
        reportId: pending.id,
        expectedRevision: source.revision,
        approve: false,
      });
      const saved = await a.state(planId);
      const restored = saved.matches.find((m) => m.id === final.id)!;
      expect(restored.qualificationBlocks).toBeUndefined();
      expect([restored.player1Id, restored.player2Id]).toEqual([final.player1Id, final.player2Id]);
      await a.shutdown();
      runtimes.delete(a);
      await b.shutdown();
      runtimes.delete(b);
      const restarted = await runtime();
      expect(await restarted.state(planId)).toEqual(saved);
      expect(await restarted.replay(planId)).toEqual(saved);
    });
});
