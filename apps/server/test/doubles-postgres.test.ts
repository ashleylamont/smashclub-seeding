import { describe, expect, it } from 'vitest';
import { players, user } from '@smashclub/db';
import { eq } from 'drizzle-orm';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { postgresCluster } from './helpers/postgres';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createPlan, freezeRoster, generatePools } from '../src/event-planner/plans';
import { addDoublesPair } from '../src/event-planner/nativePlanner';
import { createPostgresNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import type { TournamentCommand } from '../src/tournament/schemas';

describe('doubles with durable Act-PG storage', () => {
  it('serializes substitutions and calls, replays exact retries, and retains concurrent score and result history', async () => {
    const cluster = await postgresCluster(),
      runtimes: NativeRuntime[] = [];
    try {
      await cluster.db.insert(user).values(nativeAdmin);
      const members = await cluster.db
        .insert(players)
        .values(Array.from({ length: 9 }, (_, i) => ({ canonicalName: `Player ${i}` })))
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
      let a = await createPostgresNativeRuntime(cluster.db, cluster.connectionString),
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
      const original = await a.state(planId);
      const initialMatch = original.matches[0]!;
      const slot = original.entrants.find((e) => e.playerId === initialMatch.player1Id)!;
      const incoming = members[8]!;
      const caller = (nativeRuntime: NativeRuntime) =>
        appRouter.createCaller({
          db: cluster.db,
          user: nativeAdmin,
          nativeRuntime,
          env: loadEnv({ DATABASE_URL: cluster.connectionString, NODE_ENV: 'test' }),
          challonge: new ChallongeClient({}),
          recomputeTrigger: new RecomputeTrigger(cluster.db),
        });
      const change = {
        planId,
        entrantId: slot.id,
        outgoingPlayerId: slot.memberPlayerIds![1]!,
        incomingPlayerId: incoming.id,
        reason: 'Original partner unavailable',
      };
      await command(a, {
        kind: 'configureDispatch',
        capacity: 1,
        reservedStationIds: [],
        expectedResourceRevision: original.settings.resourceRevision,
      });
      const api = caller(a).eventOps;
      const preview = await api.previewDoublesSubstitution(change);
      expect(preview.allowed).toBe(true);
      let intent = {
        ...change,
        requestId: 'racing-substitution',
        revisionToken: preview.revisionToken,
      };
      const [substituted, called] = await Promise.allSettled([
        api.applyDoublesSubstitution(intent),
        command(b, {
          kind: 'dispatch',
          matchId: initialMatch.id,
          expectedRevision: initialMatch.revision,
          expectedResourceRevision: (await b.state(planId)).settings.resourceRevision,
          stationId: null,
          callOnly: true,
        }),
      ]);
      expect([substituted.status, called.status].sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = [substituted, called].find((result) => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({
        message: expect.stringMatching(/changed since this preview|Pairing or resources changed/),
      });
      const afterRace = await api.previewDoublesSubstitution(change);
      expect(afterRace.allowed).toBe(false);
      expect(afterRace.returnCallMatchIds).toEqual(
        called.status === 'fulfilled' ? [initialMatch.id] : [],
      );
      let receipt;
      if (substituted.status === 'fulfilled') {
        receipt = substituted.value;
      } else {
        await api.updateMatch({
          matchId: initialMatch.id,
          expectedRevision: initialMatch.revision,
          status: 'ready',
          stationId: null,
        });
        const refreshed = await api.previewDoublesSubstitution(change);
        intent = {
          ...intent,
          requestId: 'reviewed-after-return',
          revisionToken: refreshed.revisionToken,
        };
        receipt = await api.applyDoublesSubstitution(intent);
      }
      const saved = await a.state(planId);
      expect(saved.baseline).toEqual(original.baseline);
      expect(saved.entrants.find((e) => e.id === slot.id)!.memberPlayerIds).toEqual([
        slot.memberPlayerIds![0],
        incoming.id,
      ]);
      await a.shutdown();
      await b.shutdown();
      runtimes.length = 0;
      await cluster.db
        .update(players)
        .set({ displayName: 'New public alias' })
        .where(eq(players.id, incoming.id));
      a = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
      b = await createPostgresNativeRuntime(cluster.db, cluster.connectionString);
      runtimes.push(a, b);
      expect(await b.replay(planId)).toEqual(saved);
      expect(await caller(b).eventOps.applyDoublesSubstitution(intent)).toEqual(receipt);
      await expect(
        caller(b).eventOps.applyDoublesSubstitution({ ...intent, reason: 'Different intent' }),
      ).rejects.toThrow(/request identifier already used/i);
      expect(await b.state(planId)).toEqual(saved);
      const first = saved.matches[0]!;
      const score: TournamentCommand = {
        kind: 'score',
        matchId: first.id,
        expectedRevision: first.revision,
        score1: 2,
        score2: 0,
        outcome: 'played',
      };
      await Promise.all([
        a.command({ ...nativeAdmin, id: 'member-a', role: 'user' }, planId, 'teammate-a', score),
        b.command({ ...nativeAdmin, id: 'member-b', role: 'user' }, planId, 'teammate-b', score),
      ]);
      const agreed = await a.state(planId);
      expect(agreed.matches.find((m) => m.id === first.id)!.revision).toBe(first.revision + 1);
      expect(agreed.reports.filter((r) => r.matchId === first.id)).toHaveLength(2);
      for (const m of agreed.matches.filter((m) => m.id !== first.id))
        await command(a, {
          kind: 'score',
          matchId: m.id,
          expectedRevision: m.revision,
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
          {
            matchId: first.id,
            expectedRevision: first.revision + 1,
            score1: 3,
            score2: 1,
            outcome: 'played',
          },
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
