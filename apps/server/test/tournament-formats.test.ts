import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq, inArray } from 'drizzle-orm';
import {
  eventPlans,
  players,
  user,
  sets,
  tournamentParticipants,
  tournaments,
  type Db,
} from '@smashclub/db';
import { isKnockout, type TournamentStructure, type StructureOptions } from '@smashclub/shared';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { captureBaseline } from '../src/tournament/domain';
import { publishNativeResult } from '../src/tournament/publication';
import { attendancePreview } from '../src/tournament/attendance';

describe('native format lifecycle through shipped APIs', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values(nativeAdmin);
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });
  const caller = () =>
    appRouter.createCaller({
      db,
      user: nativeAdmin,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  async function draft(
    count: number,
    structure: TournamentStructure,
    options: Partial<StructureOptions> = {},
    doubles = false,
  ) {
    const members = await db
      .insert(players)
      .values(
        Array.from({ length: count * (doubles ? 2 : 1) }, (_, i) => ({
          canonicalName: `Format ${crypto.randomUUID()} ${i}`,
          displayName: `Entrant ${i}`,
        })),
      )
      .returning();
    const { planId } = await caller().admin.eventPlanner.createPlan({
      name: `Format ${structure}`,
      eventDate: '2026-10-22T12:00:00Z',
      structure,
      structureOptions: { roundRobinMeetings: 1, ...options },
      competitionFormat: doubles ? 'doubles' : 'singles',
      rows: doubles
        ? []
        : members.map((p, i) => ({
            lineNumber: i + 1,
            rawInput: p.canonicalName,
            cleanedName: p.canonicalName,
            companyId: null,
            playerId: p.id,
            resolutionMethod: 'manual',
          })),
    });
    if (doubles)
      for (let i = 0; i < count; i++)
        await caller().admin.eventPlanner.addDoublesPair({
          planId,
          playerId: members[i * 2]!.id,
          partnerPlayerId: members[i * 2 + 1]!.id,
        });
    await caller().admin.eventPlanner.freezeRoster({ planId });
    await caller().admin.eventPlanner.generatePools({ planId });
    await caller().eventOps.softLockPools({ planId, confirm: true });
    await caller().eventOps.settings({ planId, published: true, playerReports: true });
    return planId;
  }
  async function scoreReady(planId: string, reset = false) {
    for (let pass = 0; pass < 100; pass++) {
      const ready = (await runtime.state(planId)).matches.filter((m) => m.status === 'ready');
      if (!ready.length) return;
      for (const m of ready) {
        const upset = reset && m.bracketLane === 'final';
        await caller().eventOps.reportScore({
          matchId: m.id,
          expectedRevision: m.revision,
          requestId: crypto.randomUUID(),
          score1: upset ? 0 : 2,
          score2: upset ? 2 : 0,
          outcome: 'played',
        });
      }
    }
    throw new Error('The draw did not converge.');
  }
  async function finishPools(planId: string) {
    await scoreReady(planId);
    const state = await runtime.state(planId);
    for (const division of new Set(state.pools.map((p) => p.division))) {
      await caller().admin.eventPlanner.savePoolPlacements({
        planId,
        division,
        pools: state.pools
          .filter((p) => p.division === division)
          .map((p) => ({
            poolIndex: p.index,
            playerIdsInOrder: p.entrantIds,
            expectedPlacementRevision: String(p.revision),
            expectedMatchRevisions: state.matches
              .filter((m) => m.poolId === p.id)
              .map((m) => ({ id: m.id, revision: m.revision })),
          })),
      });
    }
    const preview = await caller().eventOps.native.preview({ planId });
    expect(preview.allowed).toBe(true);
    await caller().eventOps.native.generate({ planId, revisionToken: preview.revisionToken });
  }
  for (const scenario of [
    { structure: 'single_elimination', count: 3, played: 2, brackets: 1 },
    { structure: 'single_elimination', count: 8, played: 7, brackets: 1 },
    { structure: 'double_elimination', count: 2, played: 2, brackets: 1 },
    { structure: 'double_elimination', count: 3, played: 4, brackets: 1 },
    { structure: 'double_elimination', count: 5, played: 9, brackets: 1, reset: true },
    {
      structure: 'double_elimination',
      count: 3,
      played: 5,
      brackets: 1,
      reset: true,
      doubles: true,
    },
    {
      structure: 'round_robin_finals',
      count: 7,
      played: 24,
      brackets: 1,
      options: { playoffSize: 4 },
    },
    {
      structure: 'round_robin_finals',
      count: 7,
      played: 26,
      brackets: 2,
      options: { playoffSize: 3, consolation: true },
    },
    {
      structure: 'pools_finals',
      count: 7,
      played: 12,
      brackets: 1,
      options: { consolation: false },
    },
    {
      structure: 'dual_division',
      count: 12,
      played: 18,
      brackets: 2,
      options: { consolation: false },
    },
  ] satisfies {
    structure: TournamentStructure;
    count: number;
    played: number;
    brackets: number;
    reset?: boolean;
    doubles?: boolean;
    options?: Partial<StructureOptions>;
  }[])
    it(`runs ${scenario.structure} with ${scenario.count} entrants${scenario.reset ? ' and a reset' : ''}${scenario.doubles ? ' in doubles' : ''}`, async () => {
      const planId = await draft(
        scenario.count,
        scenario.structure,
        scenario.options,
        scenario.doubles,
      );
      const locked = await runtime.state(planId);
      expect(await runtime.replay(planId)).toEqual(locked);
      expect(captureBaseline(structuredClone(locked.baseline!))).toMatchObject({
        matches: locked.baseline!.matches,
      });
      if (!isKnockout(scenario.structure)) await finishPools(planId);
      await scoreReady(planId, scenario.reset);
      const played = await runtime.state(planId);
      expect(played.matches.filter((m) => m.outcome === 'played')).toHaveLength(scenario.played);
      expect(played.matches.every((m) => m.status === 'complete')).toBe(true);
      await caller().eventOps.native.finalize({ planId });
      const final = await runtime.state(planId);
      expect(final.brackets).toHaveLength(scenario.brackets);
      expect(final.lifecycle).toBe('finalized');
      expect(final.publication!.tournamentIds).toHaveLength(scenario.brackets);
      const exported = await db
        .select()
        .from(sets)
        .where(inArray(sets.tournamentId, final.publication!.tournamentIds));
      expect(exported.filter((s) => !s.excludedFromRatings)).toHaveLength(scenario.played);
      expect(exported.filter((s) => s.scoresCsv)).toHaveLength(scenario.played);
      const before = exported.length;
      await publishNativeResult(db, final.result!);
      expect(
        await db
          .select()
          .from(sets)
          .where(inArray(sets.tournamentId, final.publication!.tournamentIds)),
      ).toHaveLength(before);
      const standings = await db
        .select()
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, final.publication!.tournamentIds[0]!));
      expect(standings.filter((p) => p.finalRank === 1)).toHaveLength(1);
      expect(await runtime.replay(planId)).toEqual(final);
      const snapshot = await caller().eventOps.snapshot({ planId });
      expect(snapshot.matches).toHaveLength(final.matches.filter((m) => !m.skipped).length);
      expect(snapshot.nativeBrackets.every((b) => b.complete)).toBe(true);
      const [history] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, final.publication!.tournamentIds[0]!));
      expect((history!.raw as { tournamentType: string }).tournamentType).toBe(
        scenario.structure === 'double_elimination' ? 'double elimination' : 'single elimination',
      );
    });

  it.each(['single_elimination', 'double_elimination'] as const)(
    'withdraws a knockout entrant without pools in %s and excludes automatic forfeits from ratings',
    async (structure) => {
      const planId = await draft(5, structure);
      const state = await runtime.state(planId);
      const playerId = state.matches.find((m) => m.status === 'ready')!.player1Id!;
      const preview = attendancePreview(state, { action: 'withdraw', playerId });
      expect(preview.allowed).toBe(true);
      await caller().eventOps.live.command({
        planId,
        requestId: crypto.randomUUID(),
        command: {
          kind: 'attendance',
          action: 'withdraw',
          playerId,
          reason: 'Left the venue',
          approveRedistribution: false,
          revisionToken: preview.revisionToken,
        },
      });
      await scoreReady(planId);
      await caller().eventOps.native.finalize({ planId });
      const final = await runtime.state(planId);
      expect(final.matches.some((m) => m.outcome === 'forfeit')).toBe(true);
      expect(
        final.matches
          .filter((m) => m.outcome === 'played')
          .every((m) => ![m.player1Id, m.player2Id].includes(playerId)),
      ).toBe(true);
      const published = await db
        .select()
        .from(sets)
        .where(inArray(sets.tournamentId, final.publication!.tournamentIds));
      expect(published.filter((s) => !s.excludedFromRatings)).toHaveLength(
        final.matches.filter((m) => m.outcome === 'played').length,
      );
      expect(await runtime.replay(planId)).toEqual(final);
    },
  );

  it('routes a known native match without loading unrelated event journals', async () => {
    const unrelatedId = await draft(3, 'single_elimination');
    const planId = await draft(3, 'double_elimination');
    // Populate routing from the same snapshot request a scoring surface uses.
    await caller().eventOps.snapshot({ planId: unrelatedId });
    const snapshot = await caller().eventOps.snapshot({ planId });
    const match = snapshot.matches.find((m) => m.status === 'ready')!;
    const loads = vi.spyOn(runtime, 'state');
    try {
      await caller().eventOps.reportScore({
        matchId: match.id,
        expectedRevision: match.revision,
        requestId: crypto.randomUUID(),
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
      expect(loads.mock.calls.length).toBeGreaterThan(0);
      expect(loads.mock.calls.every(([loadedPlanId]) => loadedPlanId === planId)).toBe(true);
    } finally {
      loads.mockRestore();
    }
  });

  it('rejects stale competing scores, preserves loser feeds, and protects a sealed reset topology during correction', async () => {
    const planId = await draft(3, 'double_elimination');
    const match = (await runtime.state(planId)).matches.find((m) => m.status === 'ready')!;
    const attempts = await Promise.allSettled(
      [0, 1].map((side) =>
        caller().eventOps.reportScore({
          matchId: match.id,
          expectedRevision: match.revision,
          requestId: `race-${side}`,
          score1: side ? 0 : 2,
          score2: side ? 2 : 0,
          outcome: 'played',
        }),
      ),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await scoreReady(planId);
    await caller().eventOps.native.finalize({ planId });
    const state = await runtime.state(planId),
      final = state.matches.find((m) => m.bracketLane === 'final')!;
    await expect(
      caller().eventOps.live.command({
        planId,
        requestId: 'bad-reset-correction',
        command: {
          kind: 'replaceResult',
          resultId: state.result!.id,
          reason: 'Would need a reset that was never played',
          corrections: [
            {
              matchId: final.id,
              expectedRevision: final.revision,
              outcome: 'played',
              score1: 0,
              score2: 2,
            },
          ],
        },
      }),
    ).rejects.toThrow(/routes|reset final/);
    await caller().eventOps.live.command({
      planId,
      requestId: 'same-winner-correction',
      command: {
        kind: 'replaceResult',
        resultId: state.result!.id,
        reason: 'Reviewed game score',
        corrections: [
          {
            matchId: final.id,
            expectedRevision: final.revision,
            outcome: 'played',
            score1: 3,
            score2: 0,
          },
        ],
      },
    });
    const corrected = await runtime.state(planId);
    expect(corrected.result!.revision).toBe(2);
    expect(await runtime.replay(planId)).toEqual(corrected);
  });

  it('rejects impossible playoff cuts before freezing and locks the chosen topology against regeneration', async () => {
    await expect(draft(3, 'round_robin_finals', { playoffSize: 4 })).rejects.toThrow(/playoff cut/);
    const planId = await draft(3, 'single_elimination');
    await expect(
      caller().admin.eventPlanner.updateNativeFormat({ planId, structure: 'double_elimination' }),
    ).rejects.toThrow(/draft|owned/);
    const state = await runtime.state(planId);
    const bad = structuredClone(state.baseline!);
    const child = bad.matches.find((m) => m.parent1Id)!;
    child.parent1Id = child.id;
    expect(() => captureBaseline(bad)).toThrow(/earlier matches/);
    const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId));
    expect(plan!.structure).toBe('single_elimination');
  });
});
