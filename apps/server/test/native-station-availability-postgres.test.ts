import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { dispatchDesk } from '../src/tournament/dispatch';
import { nativeEventHistory } from '../src/tournament/history';
import type { TournamentCommand, TournamentState } from '../src/tournament/schemas';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';

describe('durable named station availability', () => {
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

  it('rejects disabled and occupied resource commands across stores and restart without losing match history', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const a = await runtime(),
      b = await runtime();
    const command = (runtime: NativeRuntime, input: TournamentCommand) =>
      runtime.command(nativeAdmin, planId, crypto.randomUUID(), input);
    await a.lock(nativeAdmin, planId);
    const stationId = crypto.randomUUID();
    await command(a, {
      kind: 'station',
      id: stationId,
      name: 'Main stage',
      expectedResourceRevision: 0,
    });
    await command(a, {
      kind: 'configureDispatch',
      capacity: 1,
      reservedStationIds: [stationId],
      expectedResourceRevision: 1,
    });
    let state = await a.state(planId);
    const first = state.matches.find((match) => match.status === 'ready')!;
    const start = (current: TournamentState, matchId: string): TournamentCommand => ({
      kind: 'dispatch',
      matchId,
      stationId,
      expectedRevision: current.matches.find((match) => match.id === matchId)!.revision,
      expectedResourceRevision: current.settings.resourceRevision,
      callOnly: true,
    });
    const resources = (current: TournamentState, enabled: boolean): TournamentCommand => ({
      kind: 'resources',
      capacity: current.settings.capacity,
      expectedResourceRevision: current.settings.resourceRevision,
      stations: current.stations.map((station) => ({
        ...station,
        enabled: station.id === stationId ? enabled : station.enabled,
      })),
    });
    // An untaken named call is protected just as actual play is.
    await command(a, start(state, first.id));
    state = await b.state(planId);
    const called = structuredClone(state.matches.find((match) => match.id === first.id)!);
    expect(called).toMatchObject({ stationId, status: 'playing', started: false });
    await expect(command(b, resources(state, false))).rejects.toThrow(/station is still in use/i);
    await expect(
      command(b, {
        kind: 'station',
        id: stationId,
        name: null,
        expectedResourceRevision: state.settings.resourceRevision,
      }),
    ).rejects.toThrow(/still in use/i);
    expect((await a.state(planId)).matches.find((match) => match.id === first.id)).toEqual(called);
    await command(a, {
      kind: 'beginPlay',
      matchId: first.id,
      expectedRevision: called.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    state = await b.state(planId);
    await expect(command(b, resources(state, false))).rejects.toThrow(/station is still in use/i);
    await command(a, {
      kind: 'score',
      matchId: first.id,
      expectedRevision: first.revision,
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    state = await a.state(planId);
    const recorded = structuredClone(state.matches.find((match) => match.id === first.id)!);
    const target = state.matches.find((match) => match.status === 'ready')!;
    const staleStart = start(state, target.id);
    await command(a, resources(state, false));
    await expect(command(b, staleStart)).rejects.toThrow(/changed/i);
    const disabled = await b.state(planId);
    await expect(command(b, start(disabled, target.id))).rejects.toThrow(/station.*unavailable/i);
    expect(
      dispatchDesk(disabled).queue.every((row) => !row.eligibleStationIds.includes(stationId)),
    ).toBe(true);
    expect(disabled.settings.capacity).toBe(1);
    expect(disabled.stations).toEqual([
      { id: stationId, name: 'Main stage', enabled: false, revision: 1 },
    ]);
    expect(disabled.matches.find((match) => match.id === first.id)).toEqual(recorded);
    const beforeRestart = await nativeEventHistory(b, cluster.db, planId);
    expect(
      beforeRestart.entries.find(
        (entry) =>
          entry.matchId === first.id &&
          (entry.details as { command?: TournamentCommand }).command?.kind === 'dispatch',
      )?.details,
    ).toMatchObject({ command: { kind: 'dispatch', stationId } });
    await a.shutdown();
    runtimes.delete(a);
    await b.shutdown();
    runtimes.delete(b);
    const restarted = await runtime();
    expect(await restarted.state(planId)).toEqual(disabled);
    expect(await restarted.replay(planId)).toEqual(disabled);
    expect(await nativeEventHistory(restarted, cluster.db, planId)).toEqual(beforeRestart);
    await expect(command(restarted, start(disabled, target.id))).rejects.toThrow(
      /station.*unavailable/i,
    );
    await command(restarted, resources(disabled, true));
    const enabled = await restarted.state(planId);
    expect(enabled.stations).toEqual([
      { id: stationId, name: 'Main stage', enabled: true, revision: 2 },
    ]);
    expect(enabled.settings.capacity).toBe(1);
    expect(
      dispatchDesk(enabled).queue.find((row) => row.matchId === target.id)!.eligibleStationIds,
    ).toContain(stationId);
    await command(restarted, start(enabled, target.id));
    const final = await restarted.state(planId);
    expect(final.matches.find((match) => match.id === target.id)).toMatchObject({
      stationId,
      status: 'playing',
    });
    expect(final.matches.find((match) => match.id === first.id)).toEqual(recorded);
    expect(final.settings.capacity).toBe(1);
    expect(dispatchDesk(final).active).toBe(0);
    expect(await restarted.replay(planId)).toEqual(final);
  });
});
