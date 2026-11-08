import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { eq, inArray } from 'drizzle-orm';
import {
  eventOperators,
  eventPlans,
  nativeResultPublications,
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
import { loadSinglesHistory } from '../src/recompute/inputs';
import { captureBaseline } from '../src/tournament/domain';
import { publishNativeResult } from '../src/tournament/publication';
import { attendancePreview } from '../src/tournament/attendance';
import type { SessionUser } from '../src/auth';

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
  const context = (actor: SessionUser | null) => ({
    db,
    user: actor,
    nativeRuntime: runtime,
    env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(db),
  });
  const caller = (actor: SessionUser | null = nativeAdmin) =>
    appRouter.createCaller(context(actor));
  async function rpc(path: string, input: object, actor: SessionUser | null) {
    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      router: appRouter,
      req: new Request(`http://localhost/trpc/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      createContext: () => context(actor),
    });
    const body = (await response.json()) as {
      error?: { message: string; data: Record<string, unknown> };
      result?: { data: { reportId: string } };
    };
    return { status: response.status, body };
  }
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

  it('confirms and publishes a tied 17-player round robin through the planner', async () => {
    const planId = await draft(17, 'round_robin');
    const original = await runtime.state(planId);
    const [pool] = original.pools;
    expect(original.pools).toHaveLength(1);
    expect(original.matches).toHaveLength(136);
    const worksheet = async () =>
      (await caller().admin.eventPlanner.plan({ planId }))!.divisions[0]!.pools[0]!;
    const staleToken = (await worksheet()).matchRevisionToken;
    const positions = new Map(pool!.entrantIds.map((id, index) => [id, index]));
    for (const match of original.matches) {
      const difference =
        (positions.get(match.player2Id!)! - positions.get(match.player1Id!)! + 17) % 17;
      const firstWins = difference <= 8;
      await caller().eventOps.reportScore({
        matchId: match.id,
        expectedRevision: match.revision,
        requestId: match.id,
        score1: firstWins ? 2 : 0,
        score2: firstWins ? 0 : 2,
        outcome: 'played',
      });
    }
    const ready = await runtime.state(planId);
    expect(ready.matches.every((m) => m.status === 'complete')).toBe(true);
    expect(
      pool!.entrantIds.map((id) => ready.matches.filter((m) => m.winnerId === id).length),
    ).toEqual(Array(17).fill(8));
    const overview = await caller().eventOps.overview({ planId });
    expect('poolOrders' in overview && overview.poolOrders?.[0]).toMatchObject({
      status: 'ruling_required',
      plannerConfirmation: { available: true },
    });
    const current = await worksheet();
    expect(current.matchRevisionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(current.matchRevisionToken).not.toBe(staleToken);
    expect(current.matchRevisions).toHaveLength(136);
    const order = [...pool!.entrantIds].reverse();
    const input = {
      poolIndex: current.poolIndex,
      playerIdsInOrder: order,
      expectedPlacementRevision: current.placementRevision,
      expectedMatchRevisionToken: current.matchRevisionToken,
    };
    const save = (
      change: Partial<typeof input> & {
        expectedMatchRevisions?: typeof current.matchRevisions;
      } = {},
      actor: SessionUser | null = nativeAdmin,
    ) =>
      rpc(
        'admin.eventPlanner.savePoolPlacements',
        { planId, division: 'upper', pools: [{ ...input, ...change }] },
        actor,
      );

    expect((await save({}, null)).status).toBe(401);
    expect((await save({ expectedMatchRevisions: current.matchRevisions })).status).toBe(400);
    expect(
      (
        await save({
          expectedMatchRevisions: current.matchRevisions,
          expectedMatchRevisionToken: undefined,
        })
      ).status,
    ).toBe(400);
    expect((await save({ expectedMatchRevisionToken: 'invalid' })).status).toBe(400);
    expect(await save({ expectedMatchRevisionToken: staleToken })).toMatchObject({
      status: 409,
      body: { error: { message: expect.stringContaining('changed') } },
    });
    expect(
      await save({ expectedPlacementRevision: String(ready.pools[0]!.revision - 1) }),
    ).toMatchObject({
      status: 409,
      body: { error: { message: 'Pool order changed.' } },
    });
    for (const invalid of [
      order.slice(1),
      [order[1]!, ...order.slice(1)],
      [crypto.randomUUID(), ...order.slice(1)],
    ]) {
      expect(await save({ playerIdsInOrder: invalid })).toMatchObject({
        status: 409,
        body: { error: { message: 'Include every pool entrant once.' } },
      });
    }
    expect((await runtime.state(planId)).sequence).toBe(ready.sequence);
    expect((await save()).status).toBe(200);
    const confirmed = await runtime.state(planId);
    expect(confirmed.pools[0]!.order).toEqual(order);
    expect(confirmed.matches).toEqual(ready.matches);
    expect(confirmed.brackets).toEqual([]);

    await caller().eventOps.native.finalize({ planId });
    const result = await caller(null).eventOps.snapshot({ planId });
    expect(result.plan.status).toBe('complete');
    expect(result.matches).toHaveLength(136);
    expect(result.matches.every((m) => m.stage === 'group' && m.nativeBracketId === null)).toBe(
      true,
    );
    expect(result.placements.map(({ playerId, place }) => [playerId, place])).toEqual(
      order.map((id, index) => [id, index + 1]),
    );
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
  }, 120_000);

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
      const ready = state.matches.find((m) => m.status === 'ready')!;
      const playerId = ready.player1Id!;
      const preview = attendancePreview(state, { action: 'withdraw', playerId });
      expect(preview.allowed).toBe(true);
      expect(preview.withdrawalMatches).toEqual({ [ready.id]: { forfeit: 'automatic' } });
      const closed = attendancePreview(
        { ...state, lifecycle: 'cancelled' },
        { action: 'withdraw', playerId },
      );
      expect(closed.allowed).toBe(false);
      expect(closed.withdrawalMatches?.[ready.id]?.forfeit).toBeUndefined();
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

  it.each([
    ['single_elimination', 'playing', 'organiser'],
    ['single_elimination', 'held', 'organiser'],
    ['single_elimination', 'ready', 'automatic'],
    ['double_elimination', 'playing', 'organiser'],
    ['single_elimination', 'called', 'automatic'],
    ['round_robin', 'called', 'organiser'],
  ] as const)('previews and applies %s withdrawal while %s', async (structure, phase, forfeit) => {
    const { planId, resolved } = await verifyWithdrawalPreview(
      draft,
      runtime,
      caller().eventOps,
      structure,
      phase,
      forfeit,
    );
    expect(await runtime.replay(planId)).toEqual(resolved);
  });

  it.each(['score', 'approval'] as const)(
    'returns scoped recovery for a blocked feeder %s and retries after the call returns',
    async (entry) => {
      const planId = await draft(4, 'single_elimination');
      await caller().eventOps.settings({
        planId,
        published: true,
        playerReports: true,
        scoreReportingMode: 'approve_unless_disputed',
      });
      let state = await runtime.state(planId);
      const command = (input: Parameters<NativeRuntime['command']>[3]) =>
        caller().eventOps.live.command({ planId, requestId: crypto.randomUUID(), command: input });
      await command({
        kind: 'configureDispatch',
        capacity: 2,
        reservedStationIds: [],
        expectedResourceRevision: state.settings.resourceRevision,
      });
      for (const match of state.matches.filter((m) => m.round === 1))
        await caller().eventOps.reportScore({
          matchId: match.id,
          expectedRevision: match.revision,
          requestId: crypto.randomUUID(),
          score1: 2,
          score2: 0,
          outcome: 'played',
        });
      state = await runtime.state(planId);
      const final = state.matches.find((m) => m.round === 2)!;
      const feeder = state.matches.find((m) => m.id === final.parent1Id)!;
      await command({
        kind: 'dispatch',
        matchId: final.id,
        stationId: null,
        expectedRevision: final.revision,
        expectedResourceRevision: state.settings.resourceRevision,
      });
      const input = {
        matchId: feeder.id,
        expectedRevision: feeder.revision,
        requestId: 'retry-feeder-correction',
        score1: 0,
        score2: 2,
        outcome: 'played',
      } as const;
      const assigned = {
        id: crypto.randomUUID(),
        name: 'Assigned organiser',
        email: `${crypto.randomUUID()}@example.test`,
        role: 'user',
      } as const;
      await db.insert(user).values(assigned);
      await db.insert(eventOperators).values({ eventPlanId: planId, userId: assigned.id });
      await caller().eventOps.guests.configure({ planId, enabled: true, showOnOverlay: false });
      const invitation = await caller().eventOps.guests.invitation({ planId });
      const pass = await caller(null).eventOps.guests.redeem({ planId, token: invitation!.token });
      const guestInput = { ...input, ...pass, planId, requestId: 'guest-feeder-correction' };
      const guestReport = await rpc('eventOps.guests.submit', guestInput, null);
      expect(guestReport).toMatchObject({
        status: 200,
        body: { result: { data: { status: 'pending' } } },
      });
      const staleGuest = await rpc(
        'eventOps.guests.submit',
        {
          ...guestInput,
          expectedRevision: feeder.revision + 1,
          requestId: 'stale-guest-correction',
        },
        null,
      );
      expect(staleGuest.status).toBe(409);
      expect(staleGuest.body.error!.data).not.toHaveProperty('returnUntakenCallMatchIds');
      const report = { reportId: guestReport.body.result!.data.reportId, approve: true };
      const attendee = { ...assigned, id: crypto.randomUUID() };
      const denied = await rpc('eventOps.reviewReport', report, attendee);
      expect(denied.status).toBe(403);
      expect(denied.body.error!.data).not.toHaveProperty('returnUntakenCallMatchIds');
      const staleAttendee = await rpc(
        'eventOps.reportScore',
        { ...input, expectedRevision: feeder.revision + 1 },
        attendee,
      );
      expect(staleAttendee.status).toBe(409);
      expect(staleAttendee.body.error!.data).not.toHaveProperty('returnUntakenCallMatchIds');
      const staleOperator = await rpc(
        'eventOps.reportScore',
        { ...input, expectedRevision: feeder.revision + 1 },
        nativeAdmin,
      );
      expect(staleOperator.status).toBe(409);
      expect(staleOperator.body.error!.data).not.toHaveProperty('returnUntakenCallMatchIds');
      const before = await runtime.state(planId);
      const attempt = () =>
        entry === 'score'
          ? rpc('eventOps.reportScore', input, nativeAdmin)
          : rpc('eventOps.reviewReport', report, assigned);
      expect(await attempt()).toMatchObject({
        status: 409,
        body: { error: { data: { returnUntakenCallMatchIds: [final.id] } } },
      });
      expect(await runtime.state(planId)).toEqual(before);
      await command({
        kind: 'matchControl',
        matchId: final.id,
        stationId: null,
        status: 'ready',
        reason: null,
        expectedRevision: final.revision,
        expectedResourceRevision: before.settings.resourceRevision,
      });
      expect((await attempt()).status).toBe(200);
      const corrected = await runtime.state(planId);
      const correctedFinal = corrected.matches.find((m) => m.id === final.id)!;
      expect(correctedFinal.player1Id).toBe(feeder.player2Id);
      expect(await runtime.replay(planId)).toEqual(corrected);
      await command({
        kind: 'dispatch',
        matchId: correctedFinal.id,
        stationId: null,
        callOnly: false,
        expectedRevision: correctedFinal.revision,
        expectedResourceRevision: corrected.settings.resourceRevision,
      });
      const actualPlay = await rpc(
        'eventOps.reportScore',
        {
          ...input,
          expectedRevision: corrected.matches.find((m) => m.id === feeder.id)!.revision,
          requestId: 'feeder-after-start',
          score1: 2,
          score2: 0,
        },
        nativeAdmin,
      );
      expect(actualPlay.status).toBe(409);
      expect(actualPlay.body.error!.message).toMatch(/downstream actual play/);
      expect(actualPlay.body.error!.data).not.toHaveProperty('returnUntakenCallMatchIds');
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

  it.each([
    { structure: 'single_elimination', count: 4, finalOutcome: 'played' },
    { structure: 'pools_finals', count: 7, finalOutcome: 'played' },
    { structure: 'single_elimination', count: 4, finalOutcome: 'forfeit' },
  ] as const)(
    'protects published $structure feeder routes through a $finalOutcome final',
    async ({ structure, count, finalOutcome }) => {
      const planId = await draft(count, structure, { consolation: false });
      if (!isKnockout(structure)) await finishPools(planId);
      if (finalOutcome === 'forfeit') {
        const opening = (await runtime.state(planId)).matches.filter((m) => m.status === 'ready');
        for (const match of opening)
          await caller().eventOps.reportScore({
            matchId: match.id,
            expectedRevision: match.revision,
            requestId: crypto.randomUUID(),
            score1: 2,
            score2: 0,
            outcome: 'played',
          });
        const current = await runtime.state(planId);
        const playerId = current.matches.find((m) => m.round === 2)!.player2Id!;
        const preview = attendancePreview(current, { action: 'withdraw', playerId });
        await caller().eventOps.live.command({
          planId,
          requestId: 'withdraw-before-final',
          command: {
            kind: 'attendance',
            action: 'withdraw',
            playerId,
            reason: 'Left before the final',
            approveRedistribution: false,
            revisionToken: preview.revisionToken,
          },
        });
      }
      await scoreReady(planId);
      await caller().eventOps.native.finalize({ planId });
      const sealed = await runtime.state(planId);
      const final = sealed.matches.find((m) => m.bracketId && m.round === 2)!;
      const feeder = sealed.matches.find((m) => m.id === final.parent1Id)!;
      expect(final).toMatchObject({ outcome: finalOutcome, player1Id: feeder.winnerId });
      expect(feeder.winnerId).toBe(feeder.player1Id);
      const tournamentIds = sealed.publication!.tournamentIds;
      const published = async () => {
        const publications = await db
          .select()
          .from(nativeResultPublications)
          .where(eq(nativeResultPublications.eventPlanId, planId))
          .orderBy(nativeResultPublications.revision);
        const standings = await db
          .select()
          .from(tournamentParticipants)
          .where(inArray(tournamentParticipants.tournamentId, tournamentIds))
          .orderBy(tournamentParticipants.id);
        const { engineSets } = await loadSinglesHistory(db);
        return {
          publications,
          standings,
          ratingInputs: engineSets
            .filter((set) => tournamentIds.includes(set.tournamentId))
            .toSorted((a, b) => a.id.localeCompare(b.id)),
        };
      };
      const before = await published();
      expect(before.publications.map((publication) => publication.resultId)).toEqual([
        sealed.result!.id,
      ]);
      expect(before.standings.find((p) => p.playerId === feeder.player2Id)?.finalRank).toBe(3);
      expect(before.ratingInputs).toHaveLength(
        sealed.matches.filter((m) => m.outcome === 'played').length,
      );
      await expect(
        caller().eventOps.live.command({
          planId,
          requestId: 'reverse-published-feeder',
          command: {
            kind: 'replaceResult',
            resultId: sealed.result!.id,
            reason: 'Reviewed semifinal winner',
            corrections: [
              {
                matchId: feeder.id,
                expectedRevision: feeder.revision,
                score1: 0,
                score2: 2,
                outcome: 'played',
              },
            ],
          },
        }),
      ).rejects.toThrow(/winner change would invalidate a recorded downstream pairing/i);
      expect(await runtime.state(planId)).toEqual(sealed);
      expect(await runtime.replay(planId)).toEqual(sealed);
      expect(await published()).toEqual(before);
    },
  );

  it('publishes same-winner feeder edits and terminal winner corrections', async () => {
    const planId = await draft(4, 'single_elimination');
    await scoreReady(planId);
    await caller().eventOps.native.finalize({ planId });
    const sealed = await runtime.state(planId);
    const final = sealed.matches.find((m) => m.round === 2)!;
    const feeder = sealed.matches.find((m) => m.id === final.parent1Id)!;
    await caller().eventOps.live.command({
      planId,
      requestId: 'correct-without-changing-feeders',
      command: {
        kind: 'replaceResult',
        resultId: sealed.result!.id,
        reason: 'Reviewed game score and terminal winner',
        corrections: [
          {
            matchId: feeder.id,
            expectedRevision: feeder.revision,
            score1: 3,
            score2: 0,
            outcome: 'played',
          },
          {
            matchId: final.id,
            expectedRevision: final.revision,
            score1: 0,
            score2: 2,
            outcome: 'played',
          },
        ],
      },
    });
    const corrected = await runtime.state(planId);
    expect(corrected.result).toMatchObject({
      revision: 2,
      replacesResultId: sealed.result!.id,
    });
    expect(corrected.matches.find((m) => m.id === feeder.id)).toMatchObject({
      winnerId: feeder.winnerId,
      score1: 3,
    });
    expect(corrected.matches.find((m) => m.id === final.id)).toMatchObject({
      player1Id: final.player1Id,
      player2Id: final.player2Id,
      winnerId: final.player2Id,
    });
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

async function verifyWithdrawalPreview(
  draft: (count: number, structure: TournamentStructure) => Promise<string>,
  runtime: NativeRuntime,
  api: ReturnType<typeof appRouter.createCaller>['eventOps'],
  structure: TournamentStructure,
  phase: 'playing' | 'held' | 'ready' | 'called',
  forfeit: 'automatic' | 'organiser',
) {
  const planId = await draft(4, structure);
  const started = phase === 'playing' || phase === 'held';
  const command = (input: Parameters<NativeRuntime['command']>[3]) =>
    api.live.command({ planId, requestId: crypto.randomUUID(), command: input });
  const stationId = crypto.randomUUID();
  let state = await runtime.state(planId);
  await command({
    kind: 'station',
    id: stationId,
    name: 'Stage',
    expectedResourceRevision: state.settings.resourceRevision,
  });
  state = await runtime.state(planId);
  await command({
    kind: 'configureDispatch',
    capacity: 2,
    reservedStationIds: [stationId],
    expectedResourceRevision: state.settings.resourceRevision,
  });
  state = await runtime.state(planId);

  if (structure === 'single_elimination' && phase !== 'called') {
    for (const match of state.matches.filter((m) => m.round === 1))
      await api.reportScore({
        matchId: match.id,
        expectedRevision: match.revision,
        requestId: crypto.randomUUID(),
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    state = await runtime.state(planId);
  }
  const target = state.matches.find((m) => m.status === 'ready')!;
  if (phase !== 'ready')
    await command({
      kind: 'dispatch',
      matchId: target.id,
      stationId,
      callOnly: phase === 'called',
      expectedRevision: target.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
  if (started) {
    const match = (await runtime.state(planId)).matches.find(({ id }) => id === target.id)!;
    await api.updateLiveScore({
      matchId: match.id,
      expectedRevision: match.revision,
      expectedProgressRevision: match.progressRevision,
      score1: 1,
      score2: 0,
    });
  }

  if (phase === 'held') {
    state = await runtime.state(planId);
    await command({
      kind: 'matchControl',
      matchId: target.id,
      status: 'blocked',
      stationId: null,
      expectedRevision: target.revision,
      expectedResourceRevision: state.settings.resourceRevision,
      reason: 'Stage paused',
    });
  }

  const before = await runtime.state(planId);
  const beforeMatch = before.matches.find(({ id }) => id === target.id)!;
  const input = {
    planId,
    action: 'withdraw' as const,
    playerId: target.player1Id!,
    reason: 'Left the venue',
  };
  const preview = await api.previewAttendance(input);
  expect(preview.allowed).toBe(true);
  expect(preview.returnCallMatchIds).toBeUndefined();
  expect(preview.withdrawalMatches?.[target.id]).toEqual({
    ...(phase !== 'ready' && { state: phase }),
    forfeit,
  });
  expect(preview.warnings.some((warning) => warning.includes('Calls awaiting'))).toBe(
    phase === 'called',
  );
  expect(preview.warnings.some((warning) => warning.includes('Outstanding pool pairings'))).toBe(
    structure === 'round_robin',
  );
  expect(await runtime.state(planId)).toEqual(before);

  await api.applyAttendance({
    ...input,
    revisionToken: preview.revisionToken,
    requestId: crypto.randomUUID(),
  });
  const after = await runtime.state(planId);
  const afterMatch = after.matches.find(({ id }) => id === target.id)!;
  expect(afterMatch).toMatchObject({
    player1Id: beforeMatch.player1Id,
    player2Id: beforeMatch.player2Id,
    sourceKey: beforeMatch.sourceKey,
    stationId: null,
    started,
    score1: null,
    score2: null,
    liveScore1: beforeMatch.liveScore1,
    liveScore2: beforeMatch.liveScore2,
    progressRevision: beforeMatch.progressRevision,
  });
  expect(afterMatch).toMatchObject(
    forfeit === 'organiser'
      ? {
          status: 'blocked',
          outcome: null,
          winnerId: null,
          revision: beforeMatch.revision,
          blockedReason:
            phase === 'held'
              ? 'Stage paused'
              : 'Player withdrawn: awaiting organiser forfeit decision',
        }
      : { status: 'complete', outcome: 'forfeit', winnerId: target.player2Id },
  );
  const downstream = after.matches.filter(
    (m) => m.parent1Id === target.id || m.parent2Id === target.id,
  );
  expect(structure === 'double_elimination' ? downstream.map(({ status }) => status) : []).toEqual(
    structure === 'double_elimination' ? ['blocked', 'blocked'] : [],
  );
  if (forfeit === 'organiser')
    await api.reportScore({
      matchId: target.id,
      expectedRevision: afterMatch.revision,
      requestId: crypto.randomUUID(),
      score1: 0,
      score2: 0,
      winnerId: target.player2Id!,
      outcome: 'forfeit',
    });
  const resolved = await runtime.state(planId);
  for (const completed of before.matches.filter((m) => m.status === 'complete'))
    expect(resolved.matches.find(({ id }) => id === completed.id)).toEqual(completed);
  return { planId, resolved };
}
