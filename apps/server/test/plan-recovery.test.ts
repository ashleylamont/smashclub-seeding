import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq, inArray } from 'drizzle-orm';
import {
  eventPlans,
  eventPlanEntries,
  eventStations,
  eventOperationSettings,
  eventOperators,
  nativeResultPublications,
  playerRatings,
  sets,
  players,
  user,
  type Db,
} from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { latestRecomputeId } from '../src/recompute/recompute';
import { processNativeRatingIntents, publishNativeResult } from '../src/tournament/publication';
import { loadDoublesRatings } from '../src/recompute/doubles';

describe('post-lock plan recovery', () => {
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
  const caller = (actor = nativeAdmin) =>
    appRouter.createCaller({
      db,
      user: actor,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  async function draft(format: 'singles' | 'doubles' = 'singles') {
    const members = await db
      .insert(players)
      .values(
        Array.from({ length: format === 'doubles' ? 4 : 2 }, (_, i) => ({
          canonicalName: `Recovery ${crypto.randomUUID()} ${i}`,
        })),
      )
      .returning();
    const { planId } = await caller().admin.eventPlanner.createPlan({
      name: 'Recovery rehearsal',
      eventDate: '2026-10-01T00:00:00Z',
      bracketMode: 'native',
      competitionFormat: format,
      structure: 'round_robin',
      rows:
        format === 'doubles'
          ? []
          : members.map((p, i) => ({
              lineNumber: i + 1,
              rawInput: p.canonicalName,
              cleanedName: p.canonicalName,
              companyId: null,
              playerId: p.id,
              resolutionMethod: 'manual' as const,
            })),
    });
    if (format === 'doubles')
      for (let i = 0; i < 2; i++)
        await caller().admin.eventPlanner.addDoublesPair({
          planId,
          playerId: members[i * 2]!.id,
          partnerPlayerId: members[i * 2 + 1]!.id,
          teamName: `Pair ${i}`,
        });
    return { planId, members };
  }
  async function locked(format: 'singles' | 'doubles' = 'singles') {
    const seeded = await draft(format);
    const { planId } = seeded;
    const roster = (await caller().admin.eventPlanner.plan({ planId }))!;
    await caller().admin.eventPlanner.updateEntry({
      planId,
      entryId: roster.entries[0]!.id,
      divisionPreference: 'upper',
    });
    await caller().admin.eventPlanner.freezeRoster({ planId });
    await caller().admin.eventPlanner.generatePools({ planId });
    await db.insert(eventStations).values({ eventPlanId: planId, name: 'Station 1' });
    await db.insert(eventOperationSettings).values({
      eventPlanId: planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'to_review',
    });
    await caller().eventOps.softLockPools({ planId, confirm: true });
    return { ...seeded, state: await runtime.state(planId) };
  }
  async function recover(planId: string, operation: 'reset' | 'delete', withdrawResults = false) {
    const preview = await caller().admin.eventPlanner.recoveryPreview({ planId });
    const input = {
      planId,
      operation,
      withdrawResults,
      reason: 'Rehearsal was entered by mistake',
      requestId: crypto.randomUUID(),
      token: preview.token,
    };
    const result = await caller().admin.eventPlanner.recoverPlan(input);
    return { input, result };
  }
  async function finalized(format: 'singles' | 'doubles' = 'singles') {
    const seeded = await locked(format),
      { planId, state } = seeded;
    const match = state.matches[0]!;
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'score',
      matchId: match.id,
      expectedRevision: match.revision,
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    const scored = await runtime.state(planId),
      pool = scored.pools[0]!;
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'placements',
      poolId: pool.id,
      order: pool.entrantIds,
      expectedRevision: pool.revision,
      matchRevisions: Object.fromEntries(scored.matches.map((m) => [m.id, m.revision])),
    });
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), { kind: 'finalize' });
    await runtime.drainReactions();
    const published = await runtime.state(planId);
    expect(published.publication?.tournamentIds).toHaveLength(1);
    await processNativeRatingIntents(db);
    return { ...seeded, published };
  }
  it.each(['singles', 'doubles'] as const)(
    'reverts a soft-locked %s plan to a clean draft and closes stale score forms',
    async (format) => {
      const { planId, state, members } = await locked(format);
      const { input, result } = await recover(planId, 'reset');
      const fresh = (await caller().admin.eventPlanner.plan({
        planId: result.replacementPlanId!,
      }))!;
      expect(fresh.plan.status).toBe('draft');
      expect(fresh.plan.softLockedAt).toBeNull();
      expect(fresh.plan.competitionFormat).toBe(format);
      expect(fresh.entries.map((e) => e.snapshotScore)).toEqual([null, null]);
      expect(fresh.entries[0]!.divisionPreference).toBe('upper');
      expect(fresh.entries.flatMap((e) => e.memberPlayerIds ?? [e.playerId!]).sort()).toEqual(
        members.map((p) => p.id).sort(),
      );
      expect(await caller().admin.eventPlanner.plan({ planId })).toBeNull();
      expect((await caller().admin.eventPlanner.plans()).some((p) => p.id === planId)).toBe(false);
      expect((await runtime.state(planId)).retirement?.replacementPlanId).toBe(fresh.plan.id);
      expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
      expect(await caller().admin.eventPlanner.recoverPlan(input)).toEqual(result);
      await caller().admin.eventPlanner.freezeRoster({ planId: fresh.plan.id });
      await caller().admin.eventPlanner.generatePools({ planId: fresh.plan.id });
      await caller().eventOps.softLockPools({ planId: fresh.plan.id, confirm: true });
      const newState = await runtime.state(fresh.plan.id);
      expect(newState.matches.map((m) => m.id)).not.toContain(state.matches[0]!.id);
      await expect(
        runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
          kind: 'score',
          matchId: state.matches[0]!.id,
          expectedRevision: 0,
          score1: 2,
          score2: 0,
          outcome: 'played',
        }),
      ).rejects.toThrow(/sealed/);
      expect((await runtime.state(fresh.plan.id)).matches.every((m) => !m.outcome)).toBe(true);
    },
  );
  it('rejects a stale recovery preview after another score commits', async () => {
    const { planId, state } = await locked();
    const preview = await caller().admin.eventPlanner.recoveryPreview({ planId });
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'score',
      matchId: state.matches[0]!.id,
      expectedRevision: 0,
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    await expect(
      caller().admin.eventPlanner.recoverPlan({
        planId,
        operation: 'delete',
        withdrawResults: false,
        reason: 'Stale request',
        requestId: crypto.randomUUID(),
        token: preview.token,
      }),
    ).rejects.toThrow(/changed/);
    expect((await runtime.state(planId)).lifecycle).toBe('locked');
    expect(
      (await db.select().from(eventPlans).where(eq(eventPlans.id, planId)))[0]!.deletedAt,
    ).toBeNull();
  });
  it('deletes an underway event with playing matches and pending reports without losing its audit', async () => {
    const { planId, state } = await locked();
    const attendee = { ...nativeAdmin, id: 'attendee', role: 'user' as const };
    await runtime.command(attendee, planId, crypto.randomUUID(), {
      kind: 'score',
      matchId: state.matches[0]!.id,
      expectedRevision: 0,
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    expect((await runtime.state(planId)).reports[0]!.status).toBe('pending');
    const { result } = await recover(planId, 'delete');
    expect(result.replacementPlanId).toBeNull();
    expect((await runtime.state(planId)).reports).toHaveLength(1);
    await expect(caller().eventOps.snapshot({ planId })).rejects.toThrow(
      /not found|owned|FORBIDDEN/i,
    );
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
  });
  it('can delete a previously cancelled native plan', async () => {
    const { planId } = await locked();
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'cancel',
      reason: 'Called off',
    });
    await recover(planId, 'delete');
    expect(
      (await db.select().from(eventPlans).where(eq(eventPlans.id, planId)))[0]!.deletedAt,
    ).not.toBeNull();
  });
  it('withdraws published singles history and queues rating removal while retaining immutable results', async () => {
    const { planId, members, published } = await finalized();
    const publicResult = (await caller().public.tournaments()).find(
      (t) => t.id === published.publication!.tournamentIds[0],
    )!;
    const resultId = published.result!.id;
    const { result } = await recover(planId, 'reset', true);
    const publications = await db
      .select()
      .from(nativeResultPublications)
      .where(eq(nativeResultPublications.eventPlanId, planId));
    expect(publications[0]!.resultId).toBe(resultId);
    const publicRows = await caller().public.tournaments();
    expect(publicRows.some((t) => published.publication!.tournamentIds.includes(t.id))).toBe(false);
    expect(await caller().public.tournament({ slug: publicResult.slug })).toBeNull();
    expect(await caller().public.eventOverview({ slug: publicResult.slug })).toBeNull();
    expect(await caller().public.recap({ slug: publicResult.slug })).toBeNull();
    const stored = await db
      .select()
      .from(sets)
      .where(inArray(sets.tournamentId, published.publication!.tournamentIds));
    expect(stored.every((s) => s.excludedFromRatings)).toBe(true);
    await processNativeRatingIntents(db);
    const runId = await latestRecomputeId(db);
    const ratings = await db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, runId!));
    expect(ratings.filter((r) => members.some((p) => p.id === r.playerId))).toHaveLength(0);
    expect(
      (await caller().admin.eventPlanner.plan({ planId: result.replacementPlanId! }))!.plan.status,
    ).toBe('draft');
    await publishNativeResult(db, published.result!);
    expect(
      await db
        .select()
        .from(nativeResultPublications)
        .where(eq(nativeResultPublications.eventPlanId, planId)),
    ).toHaveLength(1);
  });
  it('withdraws published doubles from pair-rating evidence without changing the sealed record', async () => {
    const { planId, published } = await finalized('doubles');
    expect(
      (await loadDoublesRatings(db, Date.parse('2026-12-01'))).provenance.sourceResultIds,
    ).toContain(published.result!.id);
    await recover(planId, 'delete', true);
    expect(
      (await loadDoublesRatings(db, Date.parse('2026-12-01'))).provenance.sourceResultIds,
    ).not.toContain(published.result!.id);
    expect((await runtime.state(planId)).result).toEqual(published.result);
  });
  it('retains published results and ratings when only the plan is deleted', async () => {
    const { planId, published } = await finalized();
    await recover(planId, 'delete', false);
    expect(
      (await caller().public.tournaments()).some((t) =>
        published.publication!.tournamentIds.includes(t.id),
      ),
    ).toBe(true);
    expect(
      (
        await db
          .select()
          .from(sets)
          .where(inArray(sets.tournamentId, published.publication!.tournamentIds))
      ).some((s) => !s.excludedFromRatings),
    ).toBe(true);
  });
  it('recovers a retirement decision after interruption before the SQL projection and does not create duplicate drafts', async () => {
    const { planId, state } = await locked('doubles');
    const replacementPlanId = crypto.randomUUID();
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'retire',
      operation: 'reset',
      replacementPlanId,
      reason: 'Interrupted reset',
      withdrawResults: false,
      expectedSequence: state.sequence,
    });
    expect(
      (await db.select().from(eventPlans).where(eq(eventPlans.id, planId)))[0]!.deletedAt,
    ).toBeNull();
    await runtime.recover();
    await runtime.recover();
    expect(
      await db.select().from(eventPlans).where(eq(eventPlans.id, replacementPlanId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(eventPlanEntries)
        .where(eq(eventPlanEntries.eventPlanId, replacementPlanId)),
    ).toHaveLength(2);
    expect(await runtime.replay(planId)).toEqual(await runtime.state(planId));
  });
  it('requires admin access even when the caller is an event organiser', async () => {
    const { planId, state } = await locked();
    const organiser = {
      ...nativeAdmin,
      id: 'organiser',
      email: 'organiser@example.test',
      role: 'user' as const,
    };
    await db.insert(user).values(organiser);
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: organiser.id });
    await expect(caller(organiser).admin.eventPlanner.recoveryPreview({ planId })).rejects.toThrow(
      /not found|owned|FORBIDDEN/i,
    );
    await expect(
      runtime.command(organiser, planId, crypto.randomUUID(), {
        kind: 'retire',
        operation: 'delete',
        replacementPlanId: null,
        reason: 'Not admin',
        withdrawResults: false,
        expectedSequence: state.sequence,
      }),
    ).rejects.toThrow(/administrator/);
  });
  it('resets an unlocked draft and preserves unresolved roster rows', async () => {
    const { planId } = await draft();
    const view = (await caller().admin.eventPlanner.plan({ planId }))!;
    await caller().admin.eventPlanner.updateEntry({
      planId,
      entryId: view.entries[0]!.id,
      playerId: null,
    });
    const { result } = await recover(planId, 'reset');
    const fresh = (await caller().admin.eventPlanner.plan({ planId: result.replacementPlanId! }))!;
    expect(fresh.entries).toHaveLength(2);
    expect(fresh.entries.filter((e) => e.playerId === null)).toHaveLength(1);
  });
});
