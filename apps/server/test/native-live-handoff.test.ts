import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { InMemoryStore } from '@rotorsoft/act';
import {
  eventMatches,
  nativeLiveHandoffs,
  nativeRatingIntents,
  nativeResultPublications,
  sets,
  tournaments,
  type Db,
} from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { envelope, nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { stageNativeBaseline } from '../src/tournament/baseline';
import { createNativeRuntime, nativeStream, type NativeRuntime } from '../src/tournament/runtime';
import { NativeTournament } from '../src/tournament/aggregate';
import { publishNativeResult, processNativeRatingIntents } from '../src/tournament/publication';
import { decide, captureBaseline, reduceDecision } from '../src/tournament/domain';
import type { TournamentCommand } from '../src/tournament/schemas';
import { reportScore, snapshot } from '../src/event-operations/service';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';

describe('native SQL handoff with PGlite (Act in memory)', () => {
  let db: Db;
  let close: () => Promise<void>;
  const runtimes: NativeRuntime[] = [];
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    for (const runtime of runtimes) await runtime.shutdown();
    await close();
  });

  it('freezes the draft and recovers an interrupted baseline append exactly once', async () => {
    const planId = await seedNativeDraft(db);
    const baseline = await stageNativeBaseline(db, nativeAdmin, planId);
    const runtime = createNativeRuntime(db, new InMemoryStore());
    runtimes.push(runtime);
    expect(
      (await runtime.app.load(NativeTournament, nativeStream(planId))).state.current[0].baseline,
    ).toBeNull();
    await expect(
      db.update(eventMatches).set({ score1: 2 }).where(eq(eventMatches.eventPlanId, planId)),
    ).rejects.toThrow(/update "event_matches"/);
    await expect(
      db.delete(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).rejects.toThrow(/delete from "native_live_handoffs"/);
    await expect(
      reportScore(db, nativeAdmin, {
        matchId: baseline.matches[0]!.id,
        requestId: 'legacy',
        expectedRevision: 0,
        score1: 2,
        score2: 0,
        outcome: 'played',
      }),
    ).rejects.toThrow(/owned by Act/);
    await expect(snapshot(db, planId, true)).rejects.toThrow(/owned by Act/);
    await runtime.recover();
    await runtime.transfer(planId);
    expect(
      (await runtime.app.query({ stream: nativeStream(planId), names: ['BaselineCapturedV1'] }))
        .count,
    ).toBe(1);
    const state = (await runtime.app.load(NativeTournament, nativeStream(planId))).state.current[0];
    expect(state.baseline).toEqual(baseline);
    expect(await runtime.replay(planId)).toEqual(state);
    const publicView = await runtime.snapshot(planId);
    expect(publicView.reports).toEqual([]);
    expect(publicView.audit).toEqual([]);
    expect(publicView.matches[0]!.player1Name).toMatch(/^Player/);
  });

  it('rolls back partial publication and survives commit followed by acknowledgement loss', async () => {
    const planId = await seedNativeDraft(db);
    let state = captureBaseline(await stageNativeBaseline(db, nativeAdmin, planId));
    function execute(command: TournamentCommand) {
      state = reduceDecision(state, decide(state, envelope(command))!);
    }
    for (const match of state.matches)
      execute({
        kind: 'score',
        matchId: match.id,
        expectedRevision: 0,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    for (const pool of state.pools)
      execute({
        kind: 'placements',
        poolId: pool.id,
        order: pool.entrantIds,
        expectedRevision: pool.revision,
        matchRevisions: Object.fromEntries(
          state.matches.filter((m) => m.poolId === pool.id).map((m) => [m.id, m.revision]),
        ),
      });
    execute({ kind: 'drawFinals' });
    for (;;) {
      const match = state.matches.find((m) => m.status === 'ready');
      if (!match) break;
      execute({
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        score1: null,
        score2: null,
        outcome: 'forfeit',
        winnerId: match.player1Id!,
      });
    }
    execute({ kind: 'finalize' });
    const result = state.result!;
    await expect(publishNativeResult(db, { ...result, revision: 2 })).rejects.toThrow(
      /Replacement result publication is not implemented/,
    );
    await expect(
      publishNativeResult(db, result, async (phase) => {
        if (phase === 'beforeReceipt') throw new Error('transaction failure');
      }),
    ).rejects.toThrow(/transaction failure/);
    expect(await db.select().from(tournaments)).toHaveLength(0);
    expect(await db.select().from(sets)).toHaveLength(0);
    expect(await db.select().from(nativeRatingIntents)).toHaveLength(0);
    await expect(
      publishNativeResult(db, result, async (phase) => {
        if (phase === 'afterCommit') throw new Error('crash after commit');
      }),
    ).rejects.toThrow(/crash/);
    const receipt = await publishNativeResult(db, result);
    expect(receipt.tournamentIds).toHaveLength(4);
    expect(await db.select().from(nativeResultPublications)).toHaveLength(1);
    expect(await db.select().from(tournaments)).toHaveLength(4);
    const stored = await db.select().from(sets);
    expect(stored).toHaveLength(result.matches.length);
    expect(
      stored
        .filter((s) => (s.raw as { outcome?: string })?.outcome === 'forfeit')
        .every((s) => s.scoresCsv === null && s.excludedFromRatings),
    ).toBe(true);
    await expect(
      processNativeRatingIntents(db, async () => {
        throw new Error('WHR interrupted');
      }),
    ).rejects.toThrow(/WHR interrupted/);
    expect((await db.select().from(nativeRatingIntents))[0]!.completedAt).toBeNull();
    expect(await processNativeRatingIntents(db)).toBe(1);
    expect(await processNativeRatingIntents(db)).toBe(0);
  });

  it('serves authoritative tRPC snapshots and cursor resync with authenticated command access', async () => {
    const planId = await seedNativeDraft(db);
    const runtime = createNativeRuntime(db, new InMemoryStore());
    runtimes.push(runtime);
    const context = {
      db,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      user: nativeAdmin,
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
      nativeRuntime: runtime,
    };
    const operator = appRouter.createCaller(context);
    const attendee = appRouter.createCaller({
      ...context,
      user: { ...nativeAdmin, id: 'attendee', role: 'user' },
    });
    const anonymous = appRouter.createCaller({ ...context, user: null });
    const adopted = await operator.eventOps.live.adopt({ planId });
    expect(adopted.cursor).toBe(1);
    await expect(
      anonymous.eventOps.live.command({
        planId,
        requestId: 'anonymous',
        command: { kind: 'unlock' },
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      attendee.eventOps.live.command({
        planId,
        requestId: 'unauthorized',
        command: { kind: 'unlock' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const match = adopted.matches[0]!;
    const input = {
      planId,
      requestId: 'trpc-retry',
      command: {
        kind: 'score' as const,
        matchId: match.id,
        expectedRevision: match.revision,
        score1: 2,
        score2: 0,
        outcome: 'played' as const,
      },
    };
    const first = await attendee.eventOps.live.command(input);
    expect((await attendee.eventOps.live.command(input)).receipt).toEqual(first.receipt);
    const publicView = await anonymous.eventOps.live.snapshot({ planId, cursor: adopted.cursor });
    expect(publicView.resync).toBe(true);
    expect(publicView.cursor).toBe(2);
    expect(publicView.matches.find((m) => m.id === match.id)!.score1).toBe(2);
    expect(publicView.reports).toEqual([]);
    expect(publicView.audit).toEqual([]);
    expect(publicView.entrants.every((e) => e.name.startsWith('Player'))).toBe(true);
    expect((await operator.eventOps.live.overview({ planId })).reports).toHaveLength(1);
    expect(
      (await anonymous.eventOps.live.snapshot({ planId, cursor: publicView.cursor })).unchanged,
    ).toBe(true);
    await expect(anonymous.eventOps.snapshot({ planId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
