import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ratingEvents, sets, tournaments, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { SyncScheduler } from '../src/scheduler';
import { latestRecomputeId, runRecompute } from '../src/recompute/recompute';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import type { RecomputeTrigger } from '../src/recompute/trigger';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });
const migration = await readFile(new URL('../../../packages/db/migrations/0011_backfill_group_stage_results.sql', import.meta.url), 'utf8');

it('queues legacy imports but leaves stage-aware imports and in-progress syncs alone', async () => {
  for (const [slug, raw, syncState] of [
    ['old', { state: 'complete' }, 'synced'],
    ['unknown', null, 'synced'],
    ['new-single', { groupStageEnabled: false }, 'synced'],
    ['new-groups', { groupStageEnabled: true }, 'synced'],
    ['busy', {}, 'syncing'],
  ] as const) {
    await db.insert(tournaments).values({ challongeSlug: slug, name: slug, raw, syncState, resultsMode: 'final_stage_only', lastSyncedAt: new Date() });
  }
  await db.execute(sql.raw(migration));
  const rows = await db.select().from(tournaments);
  for (const row of rows) {
    const legacy = ['old', 'unknown'].includes(row.challongeSlug);
    expect(row.syncState).toBe(legacy ? 'registered' : row.challongeSlug === 'busy' ? 'syncing' : 'synced');
    expect(row.lastSyncedAt === null).toBe(legacy);
    expect(row.resultsMode).toBe('final_stage_only');
  }
});

it('recovers pools from a completed legacy import and requests a rating recompute exactly once', async () => {
  await importRegistryPlayers(db, [
    { id: 'a', canonical_name: 'Alpha', company: 'ATL', aliases: [] },
    { id: 'b', canonical_name: 'Bravo', company: 'ATL', aliases: [] },
  ]);
  await registerTournamentSlugs(db, ['staged']);
  const [t] = await db.select().from(tournaments);
  const fixture: FixtureTournament = { slug: 'staged', state: 'complete', participants: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Bravo' }],
    matches: [{ id: 2, p1: 1, p2: 2, winner: 2, stage: 'final', order: 2 }] };
  await syncTournament(db, fixtureClient([fixture]), t!.id);
  await db.update(tournaments).set({ raw: { state: 'complete' } }).where(eq(tournaments.id, t!.id));
  await runRecompute(db);
  const baseline = await latestRecomputeId(db);
  expect(await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, baseline!))).toHaveLength(2);

  await db.execute(sql.raw(migration));
  const client = fixtureClient([{ ...fixture, matches: [
    { id: 1, p1: 1, p2: 2, winner: 1, stage: 'group', order: 1 }, ...fixture.matches,
  ] }]);
  const request = vi.fn();
  const trigger = { request } as unknown as RecomputeTrigger;
  const scheduler = new SyncScheduler(db, client, trigger, () => {});
  // Exercise the actual sweep, without starting its timers.
  await (scheduler as unknown as { sweep(): Promise<void> }).sweep();
  expect(request).toHaveBeenCalledTimes(1);
  const stored = await db.select().from(sets);
  expect(stored.map(s => s.resultStage).sort()).toEqual(['final', 'group']);
  expect(stored.every(s => s.p1PlayerId && s.p2PlayerId)).toBe(true);
  await runRecompute(db);
  const current = await latestRecomputeId(db);
  const events = await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, current!));
  expect(events).toHaveLength(4);
  const group = stored.find(s => s.resultStage === 'group')!;
  expect(events.filter(e => e.setId === group.id)).toHaveLength(2);
  expect(events.some(e => e.preRating !== e.postRating)).toBe(true);
  const caller = appRouter.createCaller({ db, user: null, challonge: client, recomputeTrigger: trigger,
    env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', BETTER_AUTH_SECRET: 'test-secret-test-secret-test' }) });
  const profile = await caller.public.player({ playerId: group.p1PlayerId! });
  const profileEvents = profile && 'events' in profile ? (profile.events ?? []) : [];
  expect(profileEvents.filter(e => !e.isDecay)).toHaveLength(2);
  expect(profileEvents.filter(e => !e.isDecay).map(e => e.resultStage).sort()).toEqual(['final', 'group']);
  expect(profileEvents.filter(e => !e.isDecay).every(e => e.setId)).toBe(true);
  const tournament = await caller.public.tournament({ slug: 'staged' });
  expect(tournament!.sets.map(s => s.resultStage).sort()).toEqual(['final', 'group']);
  await (scheduler as unknown as { sweep(): Promise<void> }).sweep();
  expect(request).toHaveBeenCalledTimes(1);
});
