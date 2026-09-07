import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { tournaments, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { ChallongeClient } from '../src/challonge/client';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';
import { SyncScheduler } from '../src/scheduler';
import type { RecomputeTrigger } from '../src/recompute/trigger';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

const DAY = 24 * 60 * 60 * 1000;

function fixture(slug: string, winner = 1): FixtureTournament {
  return {
    slug,
    id: 100,
    state: 'complete',
    participants: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Bravo' }],
    matches: [{ id: 1, p1: 1, p2: 2, winner, order: 1 }],
  };
}

async function rowFor(slug: string, values: Partial<typeof tournaments.$inferInsert> = {}) {
  const [row] = await db.insert(tournaments).values({
    challongeSlug: slug,
    name: slug,
    ...values,
  }).returning();
  return row!;
}

async function setCadence(id: string, eventDate: Date, lastSyncedAt: Date | null) {
  await db.update(tournaments).set({
    eventDate,
    eventDateManual: true,
    challongeState: 'complete',
    syncState: 'synced',
    lastSyncedAt,
  }).where(eq(tournaments.id, id));
}

function scheduler(client: ReturnType<typeof fixtureClient>, request = vi.fn()) {
  const trigger = { request } as unknown as RecomputeTrigger;
  return {
    scheduler: new SyncScheduler(db, client, trigger, () => {}),
    request,
  };
}

async function sweep(s: SyncScheduler) {
  await (s as unknown as { sweep(): Promise<void> }).sweep();
}

describe('SyncScheduler sweep cadence', () => {
  it('refreshes a stale completed event from the public bracket and requests recompute only when sets change', async () => {
    const current = fixture('recent', 1);
    const row = await rowFor('recent', { syncState: 'registered' });
    const initial = scheduler(fixtureClient([current]));
    // Establish the existing set, then make the completed event eligible and stale.
    await (initial.scheduler as unknown as { syncOne(id: string, live: boolean): Promise<void> }).syncOne(row.id, false);
    await setCadence(row.id, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));

    current.matches[0]!.winner = 2;
    const client = fixtureClient([current]);
    const publicFetch = vi.spyOn(client, 'fetchPublicTournamentBundle');
    const apiFetch = vi.spyOn(client, 'fetchTournamentBundle');
    const { scheduler: staleScheduler, request } = scheduler(client);
    await sweep(staleScheduler);
    expect(request).toHaveBeenCalledTimes(1);
    expect(publicFetch).toHaveBeenCalledWith('recent');
    expect(apiFetch).not.toHaveBeenCalled();

    const [after] = await db.select().from(tournaments).where(eq(tournaments.id, row.id));
    expect(after!.syncState).toBe('synced');
    expect(after!.lastSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);

    // A stale re-poll with an unchanged bracket does not request recompute.
    await db.update(tournaments).set({ lastSyncedAt: new Date(Date.now() - 2 * DAY) }).where(eq(tournaments.id, row.id));
    await sweep(staleScheduler);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('skips fresh, old, future, and live-owned completed events', async () => {
    const now = Date.now();
    const fresh = await rowFor('fresh', { syncState: 'synced', challongeState: 'complete', eventDate: new Date(now - 2 * DAY), lastSyncedAt: new Date(now - 2 * 60 * 60 * 1000) });
    const old = await rowFor('old', { syncState: 'synced', challongeState: 'complete', eventDate: new Date(now - 31 * DAY), lastSyncedAt: new Date(now - 2 * DAY) });
    const future = await rowFor('future', { syncState: 'synced', challongeState: 'complete', eventDate: new Date(now + DAY), lastSyncedAt: new Date(now - 2 * DAY) });
    const live = await rowFor('live', { syncState: 'synced', challongeState: 'complete', eventDate: new Date(now - 2 * DAY), lastSyncedAt: new Date(now - 2 * DAY), liveUntil: new Date(now + 60_000) });
    const { scheduler: s, request } = scheduler(fixtureClient([fixture('fresh'), fixture('old'), fixture('future'), fixture('live')]));

    await sweep(s);
    expect(request).not.toHaveBeenCalled();
    const [freshAfter, oldAfter, futureAfter, liveAfter] = await Promise.all(
      [fresh.id, old.id, future.id, live.id].map((id) => db.select({ lastSyncedAt: tournaments.lastSyncedAt }).from(tournaments).where(eq(tournaments.id, id))),
    );
    expect(freshAfter![0]!.lastSyncedAt!.getTime()).toBe(now - 2 * 60 * 60 * 1000);
    expect(oldAfter![0]!.lastSyncedAt!.getTime()).toBeLessThan(now - DAY);
    expect(futureAfter![0]!.lastSyncedAt!.getTime()).toBeLessThan(now - DAY);
    expect(liveAfter![0]!.lastSyncedAt!.getTime()).toBeLessThan(now - DAY);
  });

  it('keeps the legacy registered row eligible when it has never synced', async () => {
    const row = await rowFor('legacy', { syncState: 'registered', challongeState: 'complete', eventDate: new Date(Date.now() - 2 * DAY), lastSyncedAt: null });
    const { scheduler: s, request } = scheduler(fixtureClient([fixture('legacy')]));
    await sweep(s);
    expect(request).toHaveBeenCalledTimes(1);
    const [stored] = await db.select().from(tournaments).where(eq(tournaments.id, row.id));
    expect(stored!.syncState).toBe('synced');
    expect(stored!.lastSyncedAt).not.toBeNull();
  });

  it('deduplicates overlapping sweeps while a tournament is in flight', async () => {
    const row = await rowFor('in-flight', { syncState: 'registered', challongeState: 'complete', eventDate: new Date(Date.now() - 2 * DAY), lastSyncedAt: new Date(Date.now() - 2 * DAY) });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixtureBacked = fixtureClient([fixture('in-flight')]);
    const client = new (class extends ChallongeClient {
      constructor() { super({ minRequestSpacingMs: 0 }); }
      override async fetchPublicTournamentBundle(slug: string) {
        started();
        await gate;
        return fixtureBacked.fetchTournamentBundle(slug);
      }
    })();
    const { scheduler: s, request } = scheduler(client);
    const first = (s as unknown as { syncOne(id: string, live: boolean): Promise<void> }).syncOne(row.id, false);
    await startedPromise;
    const second = (s as unknown as { syncOne(id: string, live: boolean): Promise<void> }).syncOne(row.id, false);
    release();
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(1);
    const [stored] = await db.select().from(tournaments).where(eq(tournaments.id, row.id));
    expect(stored!.syncState).toBe('synced');
  });
});
