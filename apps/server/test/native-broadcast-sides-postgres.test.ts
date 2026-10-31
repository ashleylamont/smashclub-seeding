import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { broadcastOrientation } from '@smashclub/shared';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { nativeEventHistory } from '../src/tournament/history';
import type { TournamentCommand } from '../src/tournament/schemas';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';

describe('durable concurrent broadcast sides', () => {
  let cluster: Awaited<ReturnType<typeof postgresCluster>>;
  const runtimes = new Set<NativeRuntime>();
  beforeAll(async () => {
    cluster = await postgresCluster();
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
  it('serializes desired-side setters, retains live scores across restart, and resets a replacement pairing', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const a = await runtime(),
      b = await runtime();
    const command = (
      runtime: NativeRuntime,
      input: TournamentCommand,
      requestId: string = crypto.randomUUID(),
    ) => runtime.command(nativeAdmin, planId, requestId, input);
    await a.lock(nativeAdmin, planId);
    const stationId = crypto.randomUUID();
    await command(a, {
      kind: 'station',
      id: stationId,
      name: 'Stage',
      expectedResourceRevision: 0,
    });
    await command(a, {
      kind: 'configureDispatch',
      capacity: 1,
      reservedStationIds: [stationId],
      expectedResourceRevision: 1,
    });
    let state = await a.state(planId);
    const match = state.matches.find((item) => item.status === 'ready')!;
    await command(a, {
      kind: 'dispatch',
      matchId: match.id,
      stationId,
      expectedRevision: match.revision,
      expectedResourceRevision: state.settings.resourceRevision,
      callOnly: true,
    });
    const before = await b.state(planId);
    const swap: Extract<TournamentCommand, { kind: 'broadcastSides' }> = {
      kind: 'broadcastSides',
      stationId,
      matchId: match.id,
      player1Id: match.player1Id!,
      player2Id: match.player2Id!,
      expectedMatchRevision: match.revision,
      expectedRevision: 0,
      swapped: true,
    };
    const attempts = await Promise.allSettled([command(a, swap, 'TO-A'), command(b, swap, 'TO-B')]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    state = await a.state(planId);
    expect(state.matches).toEqual(before.matches);
    expect(state.settings).toEqual(before.settings);
    expect(state.pools).toEqual(before.pools);
    expect(state.brackets).toEqual(before.brackets);
    const receipt = attempts.find((attempt) => attempt.status === 'fulfilled')!;
    const winningRequest = attempts[0]!.status === 'fulfilled' ? 'TO-A' : 'TO-B';
    expect((await command(b, swap, winningRequest)).receipt).toEqual(
      receipt.status === 'fulfilled' ? receipt.value.receipt : undefined,
    );
    await command(b, {
      kind: 'beginPlay',
      matchId: match.id,
      expectedRevision: match.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    await command(a, {
      kind: 'progress',
      matchId: match.id,
      expectedRevision: match.revision,
      expectedProgressRevision: 0,
      score1: 1,
      score2: 2,
    });
    state = await b.state(planId);
    expect(
      broadcastOrientation(
        state.matches.find((item) => item.id === match.id)!,
        state.broadcastSides,
      ),
    ).toEqual({ swapped: true, revision: 1 });
    const history = await nativeEventHistory(a, cluster.db, planId);
    expect(
      history.entries.filter((entry) => entry.eventName === 'DecisionRecordedV4'),
    ).toHaveLength(1);
    expect(await a.replay(planId)).toEqual(state);
    for (const runtime of [a, b]) {
      await runtime.shutdown();
      runtimes.delete(runtime);
    }
    const restarted = await runtime();
    expect(await restarted.state(planId)).toEqual(state);
    expect(await restarted.replay(planId)).toEqual(state);
    expect(await nativeEventHistory(restarted, cluster.db, planId)).toEqual(history);
    const publicView = await restarted.snapshot(planId);
    expect(publicView.broadcastSides).toEqual(state.broadcastSides);
    expect(publicView.matches.find((item) => item.id === match.id)).toMatchObject({
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      liveScore1: 1,
      liveScore2: 2,
      revision: match.revision,
    });
    await command(restarted, {
      kind: 'score',
      matchId: match.id,
      expectedRevision: match.revision,
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    state = await restarted.state(planId);
    const next = state.matches.find((item) => item.status === 'ready')!;
    await command(restarted, {
      kind: 'dispatch',
      matchId: next.id,
      stationId,
      expectedRevision: next.revision,
      expectedResourceRevision: state.settings.resourceRevision,
      callOnly: false,
    });
    const final = await restarted.state(planId);
    expect(
      broadcastOrientation(
        final.matches.find((item) => item.id === next.id)!,
        final.broadcastSides,
      ).swapped,
    ).toBe(false);
    await expect(command(restarted, { ...swap, expectedRevision: 1 })).rejects.toThrow(
      /pairing changed/,
    );
    expect(final.matches.find((item) => item.id === match.id)).toMatchObject({
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      score1: 2,
      score2: 1,
      winnerId: match.player1Id,
      status: 'complete',
    });
    expect(await restarted.replay(planId)).toEqual(final);
    await command(restarted, {
      ...swap,
      matchId: next.id,
      player1Id: next.player1Id!,
      player2Id: next.player2Id!,
      expectedMatchRevision: next.revision,
      expectedRevision: final.broadcastSides?.[stationId]?.revision ?? 0,
    });
    const swappedNext = await restarted.state(planId);
    expect(
      broadcastOrientation(
        swappedNext.matches.find((item) => item.id === next.id)!,
        swappedNext.broadcastSides,
      ),
    ).toEqual({ swapped: true, revision: 2 });
    expect(swappedNext.matches).toEqual(final.matches);
    expect(await restarted.replay(planId)).toEqual(swappedNext);
  });
});
