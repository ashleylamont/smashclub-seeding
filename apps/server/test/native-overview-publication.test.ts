import { InMemoryStore } from '@rotorsoft/act';
import { players, user } from '@smashclub/db';
import { expect, it, vi } from 'vitest';
import type { SessionUser } from '../src/auth';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createNativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

it('reads the draw and its publication from one Act snapshot across a real correction', async () => {
  const { db, close } = await createTestDb();
  const runtime = createNativeRuntime(db, new InMemoryStore());
  const organiser: SessionUser = {
    id: 'overview-assigned-organiser',
    name: 'Assigned organiser',
    role: 'player',
    email: 'overview-organiser@example.test',
  };
  const caller = (actor: SessionUser | null) =>
    appRouter.createCaller({
      db,
      user: actor,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  try {
    await db.insert(user).values([nativeAdmin, organiser]);
    const entrants = await db
      .insert(players)
      .values(Array.from({ length: 4 }, (_, index) => ({ canonicalName: `Entrant ${index + 1}` })))
      .returning();
    const admin = caller(nativeAdmin);
    const assigned = caller(organiser);
    const { planId } = await admin.admin.eventPlanner.createPlan({
      name: 'Archive publication provenance',
      eventDate: '2026-10-22T12:00:00Z',
      structure: 'single_elimination',
      rows: entrants.map((entrant, index) => ({
        lineNumber: index + 1,
        rawInput: entrant.canonicalName,
        cleanedName: entrant.canonicalName,
        companyId: null,
        playerId: entrant.id,
        resolutionMethod: 'manual',
      })),
    });
    await admin.admin.eventPlanner.freezeRoster({ planId });
    await admin.admin.eventPlanner.generatePools({ planId });
    await admin.eventOps.softLockPools({ planId, confirm: true });
    await expect(caller(null).eventOps.overview({ planId })).rejects.toHaveProperty(
      'code',
      'UNAUTHORIZED',
    );
    await expect(assigned.eventOps.overview({ planId })).rejects.toHaveProperty(
      'code',
      'FORBIDDEN',
    );
    await admin.eventOps.assignTo({ planId, userId: organiser.id });
    for (let round = 0; round < 2; round++) {
      const ready = (await runtime.state(planId)).matches.filter(
        (match) => match.status === 'ready',
      );
      expect(ready).toHaveLength(round === 0 ? 2 : 1);
      for (const match of ready)
        await admin.eventOps.reportScore({
          matchId: match.id,
          expectedRevision: match.revision,
          requestId: crypto.randomUUID(),
          score1: 2,
          score2: 0,
          outcome: 'played',
        });
    }
    await admin.eventOps.native.finalize({ planId });
    const sealed = await runtime.state(planId);
    const final = sealed.matches.find((match) => match.round === 2)!;
    const first = await admin.eventOps.overview({ planId });
    expect(first.publication).toMatchObject({ revision: 1, status: 'published' });
    expect(first.matches.find((match) => match.id === final.id)).toMatchObject({
      score1: 2,
      score2: 0,
      winnerId: final.player1Id,
    });

    const readState = runtime.state.bind(runtime);
    const read = vi.spyOn(runtime, 'state').mockImplementationOnce(async (requestedPlan) => {
      const captured = await readState(requestedPlan);
      await admin.eventOps.live.command({
        planId,
        requestId: 'overview-correction-between-reads',
        command: {
          kind: 'replaceResult',
          resultId: sealed.result!.id,
          reason: 'Reviewed terminal result',
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
      });
      await runtime.drainReactions();
      return captured;
    });
    const during = await assigned.eventOps.overview({ planId });
    expect(read).toHaveBeenCalledWith(planId);
    read.mockRestore();
    expect(during.publication).toEqual(first.publication);
    expect(during.matches.find((match) => match.id === final.id)).toMatchObject({
      score1: 2,
      score2: 0,
      winnerId: final.player1Id,
    });
    expect(during.nativeBrackets).toEqual(first.nativeBrackets);

    for (const operator of [admin, assigned]) {
      const after = await operator.eventOps.overview({ planId });
      expect(after.publication).toMatchObject({ revision: 2, status: 'published' });
      expect(after.matches.find((match) => match.id === final.id)).toMatchObject({
        score1: 0,
        score2: 2,
        winnerId: final.player2Id,
      });
      expect(after.nativeBrackets[0]?.winnerId).toBe(final.player2Id);
    }
  } finally {
    await runtime.shutdown();
    await close();
  }
});
