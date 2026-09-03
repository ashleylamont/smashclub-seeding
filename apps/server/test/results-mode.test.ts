import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sets, tournaments, type Db } from '@smashclub/db';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { fixtureClient } from './helpers/challongeFixtures';
import { adminCaller } from './helpers/adminCaller';
import { createTestDb } from './helpers/testDb';

describe('tournament results mode', () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    vi.spyOn(RecomputeTrigger.prototype, 'request').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
  });

  it('refreshes all stages and queues recalculation when a saved mode changes', async () => {
    const caller = appRouter.createCaller({
      db,
      env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', BETTER_AUTH_SECRET: 'test-secret-test-secret-test' }),
      user: { id: 'admin', email: 'admin@example.com', name: 'Admin', role: 'admin' },
      recomputeTrigger: new RecomputeTrigger(db),
      challonge: fixtureClient([{
        slug: 'staged', state: 'complete', completedAt: '2026-08-25T10:00:00Z',
        participants: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Bravo' }],
        matches: [
          { id: 10, p1: 1, p2: 2, winner: 1, stage: 'group' },
          { id: 20, p1: 1, p2: 2, winner: 2, stage: 'final' },
        ],
      }]),
    }).admin;
    const { tournamentId } = await caller.registerTournament({ slugOrUrl: 'staged' });
    await caller.updateTournament({ tournamentId, resultsMode: 'final_stage_only' });
    expect((await db.select().from(sets)).map((set) => set.resultStage).sort()).toEqual(['final', 'group']);
    expect(RecomputeTrigger.prototype.request).toHaveBeenCalledOnce();
  });

  it('persists the mode at registration, including final-stage-only before first sync', async () => {
    const caller = adminCaller(db);
    const result = await caller.registerTournament({
      slugOrUrl: 'finals-only',
      resultsMode: 'final_stage_only',
    });
    const [row] = await db.select().from(tournaments).where(eq(tournaments.id, result.tournamentId));
    expect(row?.resultsMode).toBe('final_stage_only');
  });

  it('rejects invalid modes at the API boundary', async () => {
    const caller = adminCaller(db);
    await expect(
      caller.registerTournament({ slugOrUrl: 'bad-mode', resultsMode: 'groups_only' as never }),
    ).rejects.toThrow();
  });

  it('keeps a saved mode change and reports sync failure', async () => {
    const caller = adminCaller(db);
    const { tournamentId } = await caller.registerTournament({ slugOrUrl: 'missing-fixture' });

    await expect(caller.updateTournament({ tournamentId, resultsMode: 'final_stage_only' })).rejects.toThrow(
      /Results setting saved.*Existing results will be recalculated.*retry Sync/i,
    );

    const [row] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
    expect(row?.resultsMode).toBe('final_stage_only');
    expect(RecomputeTrigger.prototype.request).toHaveBeenCalledOnce();
  });
});
