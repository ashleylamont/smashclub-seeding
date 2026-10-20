import { describe, expect, it } from 'vitest';
import { players, user } from '@smashclub/db';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createPlan, freezeRoster, generatePools } from '../src/event-planner/plans';
import { addDoublesPair } from '../src/event-planner/nativePlanner';
import { createPostgresNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import type { TournamentCommand } from '../src/tournament/schemas';

describe('doubles with durable Act-PG storage', () => {
  it('accepts agreeing concurrent teammate reports and reconstructs memberships and result revisions after restart', async () => {
    const cluster = await postgresCluster(),
      runtimes: NativeRuntime[] = [];
    try {
      await cluster.db.insert(user).values(nativeAdmin);
      const members = await cluster.db
        .insert(players)
        .values(Array.from({ length: 8 }, (_, i) => ({ canonicalName: `Player ${i}` })))
        .returning();
      const planId = await createPlan(
        cluster.db,
        {
          name: 'Durable doubles',
          eventDate: new Date('2026-10-01'),
          competitionFormat: 'doubles',
          structure: 'round_robin',
          rows: [],
        },
        nativeAdmin.id,
      );
      for (let i = 0; i < 4; i++)
        await addDoublesPair(cluster.db, {
          planId,
          playerId: members[2 * i]!.id,
          partnerPlayerId: members[2 * i + 1]!.id,
          teamName: null,
        });
      await freezeRoster(cluster.db, planId);
      await generatePools(cluster.db, planId);
      const a = await createPostgresNativeRuntime(cluster.db, cluster.connectionString),
        b = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
      runtimes.push(a, b);
      await a.lock(nativeAdmin, planId);
      const command = (runtime: NativeRuntime, command: TournamentCommand) =>
        runtime.command(nativeAdmin, planId, crypto.randomUUID(), command);
      await command(a, {
        kind: 'reporting',
        published: true,
        playerReports: true,
        mode: 'approve_unless_disputed',
        expectedRevision: 0,
      });
      const state = await a.state(planId),
        first = state.matches[0]!;
      const score: TournamentCommand = {
        kind: 'score',
        matchId: first.id,
        expectedRevision: 0,
        score1: 2,
        score2: 0,
        outcome: 'played',
      };
      await Promise.all([
        a.command({ ...nativeAdmin, id: 'member-a', role: 'user' }, planId, 'teammate-a', score),
        b.command({ ...nativeAdmin, id: 'member-b', role: 'user' }, planId, 'teammate-b', score),
      ]);
      const agreed = await a.state(planId);
      expect(agreed.matches.find((m) => m.id === first.id)!.revision).toBe(1);
      expect(agreed.reports.filter((r) => r.matchId === first.id)).toHaveLength(2);
      for (const m of agreed.matches.filter((m) => m.id !== first.id))
        await command(a, {
          kind: 'score',
          matchId: m.id,
          expectedRevision: 0,
          score1: 2,
          score2: 0,
          outcome: 'played',
        });
      const scored = await a.state(planId),
        pool = scored.pools[0]!;
      await command(a, {
        kind: 'placements',
        poolId: pool.id,
        expectedRevision: pool.revision,
        order: pool.entrantIds,
        matchRevisions: Object.fromEntries(scored.matches.map((m) => [m.id, m.revision])),
      });
      await command(a, { kind: 'finalize' });
      await a.drainReactions();
      const complete = await a.state(planId);
      expect(complete.publication!.tournamentIds).toHaveLength(1);
      await a.shutdown();
      await b.shutdown();
      runtimes.length = 0;
      const recovered = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
      runtimes.push(recovered);
      expect(await recovered.replay(planId)).toEqual(await recovered.state(planId));
      expect((await recovered.state(planId)).entrants.map((e) => e.memberPlayerIds)).toEqual(
        complete.entrants.map((e) => e.memberPlayerIds),
      );
      await command(recovered, {
        kind: 'replaceResult',
        resultId: complete.result!.id,
        reason: 'Reviewed game count and standings',
        roundRobinOrder: pool.entrantIds,
        corrections: [
          { matchId: first.id, expectedRevision: 1, score1: 3, score2: 1, outcome: 'played' },
        ],
      });
      await recovered.drainReactions();
      expect((await recovered.state(planId)).result!.revision).toBe(2);
      expect((await recovered.replay(planId)).result).toEqual(
        (await recovered.state(planId)).result,
      );
    } finally {
      for (const r of runtimes) await r.shutdown();
      await cluster.close();
    }
  });
});
