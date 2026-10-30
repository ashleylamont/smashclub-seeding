import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '@rotorsoft/act-pg';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import type { TournamentCommand } from '../src/tournament/schemas';

describe('unstarted native result reporting on isolated PostgreSQL', () => {
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

  it('serializes competing unstarted self-running results, deduplicates retries and replays actual play', async () => {
    const planId = await seedNativeDraft(cluster.db);
    const a = await runtime();
    const b = await runtime();
    await a.lock(nativeAdmin, planId);
    let current = await a.state(planId);
    const pool = current.pools[0]!;
    await a.command(nativeAdmin, planId, 'review-default', {
      kind: 'reporting',
      published: true,
      playerReports: true,
      mode: 'to_review',
      expectedRevision: current.settings.reportingRevision,
    });
    await a.command(nativeAdmin, planId, 'pool-policy', {
      kind: 'poolResources',
      poolId: pool.id,
      active: false,
      stationIds: [],
      selfRun: true,
      autoAcceptScores: true,
      expectedResourceRevision: current.settings.resourceRevision,
    });
    await b.transfer(planId);
    const match = (await a.state(planId)).matches.find((item) => item.poolId === pool.id)!;
    const score: TournamentCommand = {
      kind: 'score',
      matchId: match.id,
      expectedRevision: match.revision,
      score1: 2,
      score2: 0,
      outcome: 'played',
    };
    const opposing: TournamentCommand = { ...score, score1: 0, score2: 2 };
    const player = { ...nativeAdmin, id: 'reporting-attendee', role: 'user' as const };
    const guest = { ...player, id: 'guest:reporting-guest', guest: true };
    const [first, second] = await Promise.all([
      a.command(player, planId, 'first-report', score),
      b.command(guest, planId, 'opposing-report', opposing),
    ]);
    current = await a.state(planId);
    const official = current.matches.find((item) => item.id === match.id)!;
    expect(official).toMatchObject({
      status: 'complete',
      started: false,
      stationId: null,
      revision: match.revision + 1,
    });
    expect(current.reports.map((report) => [report.status, report.isDispute])).toEqual([
      ['approved', false],
      ['pending', true],
    ]);
    expect(current.matches.filter((item) => item.status === 'playing')).toHaveLength(0);
    expect(current.settings.capacity).toBe(0);
    expect((await a.command(player, planId, 'first-report', score)).receipt).toEqual(first.receipt);
    expect((await b.command(guest, planId, 'opposing-report', opposing)).receipt).toEqual(
      second.receipt,
    );
    expect((await a.state(planId)).sequence).toBe(current.sequence);

    await a.command(nativeAdmin, planId, 'correct-game-count', {
      ...score,
      expectedRevision: official.revision,
      score1: official.winnerId === match.player1Id ? 2 : 1,
      score2: official.winnerId === match.player1Id ? 1 : 2,
    });
    await expect(
      b.command({ ...player, id: 'late-attendee' }, planId, 'stale-pairing', score),
    ).rejects.toThrow(/changed/);
    const saved = await a.state(planId);
    await a.shutdown();
    runtimes.delete(a);
    await b.shutdown();
    runtimes.delete(b);
    const restarted = await runtime();
    expect(await restarted.state(planId)).toEqual(saved);
    expect(await restarted.replay(planId)).toEqual(saved);
    const overview = await restarted.snapshot(planId, true);
    expect(overview.audit.filter((entry) => entry.kind === 'dispatch')).toHaveLength(0);
  });
});
