import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { players, sets, tournaments, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { adminCaller } from './helpers/adminCaller';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { fixtureClient } from './helpers/challongeFixtures';
import { RecomputeTrigger } from '../src/recompute/trigger';

describe('TO breakthrough analysis', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await createTestDb()); });
  afterEach(async () => { await close(); });

  it('updates during a night without recompute, retains the baseline and respects exclusions', async () => {
    const [a, b] = await db.insert(players).values([{ canonicalName: 'Alpha' }, { canonicalName: 'Beta' }]).returning();
    const [past, main, side, future] = await db.insert(tournaments).values([
      { challongeSlug: 'past', name: 'Past', eventDate: new Date('2026-01-01'), syncState: 'synced' as const },
      { challongeSlug: 'main', name: 'Night Upper Division', eventDate: new Date('2026-02-01T08:00:00Z'), challongeState: 'underway', syncState: 'synced' as const },
      { challongeSlug: 'side', name: 'Night Upper Losers', eventDate: new Date('2026-02-01T10:00:00Z'), resultsMode: 'final_stage_only' as const, syncState: 'synced' as const },
      { challongeSlug: 'future', name: 'Future', eventDate: new Date('2026-03-01'), syncState: 'synced' as const },
    ]).returning();
    const row = { p1PlayerId: a!.id, p2PlayerId: b!.id, winner: 1, state: 'complete', scoresCsv: '2-0' };
    await db.insert(sets).values([
      { ...row, tournamentId: past!.id, challongeMatchId: 1, winner: 2, scoresCsv: '0-2' },
      { ...row, tournamentId: main!.id, challongeMatchId: 2, resultStage: 'group' },
      { ...row, tournamentId: main!.id, challongeMatchId: 3, winner: null, state: 'open' },
      { ...row, tournamentId: main!.id, challongeMatchId: 4, scoresCsv: '99-0' },
      { ...row, tournamentId: main!.id, challongeMatchId: 5, excludedFromRatings: true },
      { ...row, tournamentId: main!.id, challongeMatchId: 6, p2PlayerId: null },
      { ...row, tournamentId: side!.id, challongeMatchId: 7, resultStage: 'group' },
      { ...row, tournamentId: side!.id, challongeMatchId: 8 },
      { ...row, tournamentId: future!.id, challongeMatchId: 9 },
    ]);
    const caller = adminCaller(db);
    const before = (await caller.breakthrough({ eventKey: '2026-02-01' }))!;
    expect(before.complete).toBe(false);
    expect(before.brackets).toHaveLength(2);
    expect(before.coverage).toEqual({ played: 2, pending: 1, excluded: 3, unlinked: 1 });
    expect(before.rows[0]!.priorNights).toBe(1);
    expect(before.rows[0]!.sets).toHaveLength(2);
    const baseline = before.rows.find((r) => r.playerId === a!.id)!.baseline;
    const probability = before.rows.find((r) => r.playerId === a!.id)!.sets[0]!.expected;

    await db.update(sets).set({ winner: 2, scoresCsv: '0-2', state: 'complete' }).where(eq(sets.challongeMatchId, 3));
    const after = (await caller.breakthrough({ eventKey: '2026-02-01' }))!;
    expect(after.coverage.played).toBe(3);
    expect(after.coverage.pending).toBe(0);
    const updated = after.rows.find((r) => r.playerId === a!.id)!;
    expect(updated.baseline).toEqual(baseline);
    expect(updated.sets.every((s) => s.expected === probability)).toBe(true);
    expect(updated.priorSets).toBe(1);
    expect(await caller.breakthrough({ eventKey: '2026-04-01' })).toBeNull();
    await expect(caller.breakthrough({ eventKey: '2026-02-30' })).rejects.toThrow();
  });

  it('requires an organiser session', async () => {
    const context = { db, env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', BETTER_AUTH_SECRET: 'test-secret-test-secret-test' }),
      challonge: fixtureClient([]), recomputeTrigger: new RecomputeTrigger(db) };
    await expect(appRouter.createCaller({ ...context, user: null }).admin.breakthrough({ eventKey: '2026-02-01' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(appRouter.createCaller({ ...context, user: { id: 'user', name: 'Player', email: 'player@example.com', role: 'user' } }).admin.breakthrough({ eventKey: '2026-02-01' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
