import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches, eventOperators, eventPlanBrackets, eventPlanEntries, eventPlans, players, sets, syncJobs, tournaments, user, type Db } from '@smashclub/db';
import { importRegistryPlayers } from '../src/bootstrap/importRegistry';
import { refreshEventSources } from '../src/event-operations/sourceRefresh';
import { prepare, reportScore } from '../src/event-operations/service';
import { closePlan } from '../src/event-planner/plans';
import type { SessionUser } from '../src/auth';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;
let planId: string;
let ids: string[];
let tournamentId: string;
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const staff: SessionUser = { id: 'staff', role: 'user', name: 'Event TO', email: 'staff@example.test' };
const fixture: FixtureTournament = {
  slug: 'event-upper',
  participants: [{ id: 1, name: 'RefreshPlayer0' }, { id: 2, name: 'RefreshPlayer1' }],
  matches: [{ id: 1, p1: 1, p2: 2, winner: 1, scores: '2-0', stage: 'group' }],
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values([admin, staff]);
  await importRegistryPlayers(db, Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, canonical_name: `RefreshPlayer${i}`, company: 'ATL' })));
  ids = (await db.select().from(players)).sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)).map(player => player.id);
  planId = (await db.insert(eventPlans).values({ name: 'Refresh rehearsal', eventDate: new Date(), status: 'pools_ready' }).returning())[0]!.id;
  await db.insert(eventPlanEntries).values(ids.map((id, i) => ({ eventPlanId: planId, sourceLineNumber: i + 1, rawInput: 'Player', cleanedName: 'Player', playerId: id, assignedDivision: i < 4 ? 'upper' as const : 'lower' as const, divisionSeed: i % 4 + 1 })));
  tournamentId = (await db.insert(tournaments).values({ challongeSlug: fixture.slug, name: 'Upper' }).returning())[0]!.id;
  await db.insert(eventPlanBrackets).values({ eventPlanId: planId, division: 'upper', stage: 'main', tournamentId, challongeSlug: fixture.slug });
});
afterEach(async () => close());

describe('event public bracket refresh', () => {
  it('does not fetch or mutate for unauthorised users or closed events', async () => {
    const client = fixtureClient([fixture]);
    const fetch = vi.spyOn(client, 'fetchPublicTournamentBundle');
    const recompute = { request: vi.fn() };
    await expect(refreshEventSources(db, client, staff, planId, { recompute })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await closePlan(db, planId, 'complete');
    await expect(refreshEventSources(db, client, admin, planId, { recompute })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(syncJobs)).toHaveLength(0);
  });

  it('refreshes only linked unique IDs through public reads and recomputes once for changes', async () => {
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: staff.id });
    // Legacy duplicate slots must not multiply requests or writes.
    await db.insert(eventPlanBrackets).values({ eventPlanId: planId, division: 'upper', stage: 'consolation', tournamentId });
    const unrelated = (await db.insert(tournaments).values({ challongeSlug: 'unrelated', name: 'Other event' }).returning())[0]!;
    const client = fixtureClient([fixture]);
    const publicFetch = vi.spyOn(client, 'fetchPublicTournamentBundle');
    const apiFetch = vi.spyOn(client, 'fetchTournamentBundle');
    const recompute = { request: vi.fn() };
    const first = await refreshEventSources(db, client, staff, planId, { recompute });
    expect(first.brackets).toHaveLength(1);
    expect(first.brackets[0]).toMatchObject({ tournamentId, status: 'refreshed', setsChanged: 1 });
    expect(first.brackets[0]!.slots).toHaveLength(2);
    expect(first.queue).toMatchObject({ created: 12, error: null });
    expect(publicFetch).toHaveBeenCalledExactlyOnceWith(fixture.slug);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(recompute.request).toHaveBeenCalledTimes(1);
    expect((await db.select().from(sets)).some(set => set.tournamentId === unrelated.id)).toBe(false);
    const imported = (await db.select().from(eventMatches)).find(match => match.sourceSetId)!;
    expect(imported).toMatchObject({ status: 'complete', score1: 2, winnerId: ids[0] });
    const repeated = await refreshEventSources(db, client, staff, planId, { recompute });
    expect(repeated.brackets[0]!.setsChanged).toBe(0);
    expect(repeated.recomputeRequested).toBe(false);
    expect(recompute.request).toHaveBeenCalledTimes(1);
    expect(await db.select().from(sets)).toHaveLength(1);
  });

  it('reports partial failures without erasing recorded local scores', async () => {
    const broken = (await db.insert(tournaments).values({ challongeSlug: 'missing-lower', name: 'Lower' }).returning())[0]!;
    await db.insert(eventPlanBrackets).values({ eventPlanId: planId, division: 'lower', stage: 'main', tournamentId: broken.id });
    await prepare(db, planId);
    const local = (await db.select().from(eventMatches)).find(match => match.division === 'lower')!;
    await reportScore(db, admin, { matchId: local.id, expectedRevision: 0, requestId: 'local-score', score1: 2, score2: 1, outcome: 'played' });
    const result = await refreshEventSources(db, fixtureClient([fixture]), admin, planId, { recompute: { request: vi.fn() } });
    expect(result.brackets.find(bracket => bracket.tournamentId === broken.id)).toMatchObject({ status: 'failed', setsChanged: 0 });
    expect(result.brackets.find(bracket => bracket.tournamentId === tournamentId)).toMatchObject({ status: 'refreshed' });
    expect((await db.select().from(eventMatches).where(eq(eventMatches.id, local.id)))[0]).toMatchObject({ status: 'complete', score1: 2, score2: 1, syncState: 'local' });
  });

  it('rolls back a failed import and avoids recomputing failed changes', async () => {
    const recompute = { request: vi.fn() };
    const sync = vi.fn(async (tx: Db) => {
      await tx.insert(sets).values({ tournamentId, challongeMatchId: 99, state: 'complete', scoresCsv: '2-0' });
      throw new Error('Import interrupted');
    });
    const result = await refreshEventSources(db, fixtureClient([fixture]), admin, planId, { recompute, sync });
    expect(result.brackets[0]).toMatchObject({ status: 'failed', error: 'Import interrupted' });
    expect(await db.select().from(sets)).toHaveLength(0);
    expect(recompute.request).not.toHaveBeenCalled();
  });

  it('rechecks event closure after fetch and before any import', async () => {
    const client = fixtureClient([fixture]);
    const fetch = client.fetchPublicTournamentBundle.bind(client);
    vi.spyOn(client, 'fetchPublicTournamentBundle').mockImplementation(async slug => {
      const bundle = await fetch(slug);
      await closePlan(db, planId, 'complete');
      return bundle;
    });
    const result = await refreshEventSources(db, client, admin, planId, { recompute: { request: vi.fn() } });
    expect(result.brackets[0]).toMatchObject({ status: 'failed' });
    expect(result.brackets[0]!.error).toContain('closed');
    expect(await db.select().from(sets)).toHaveLength(0);
    expect(await db.select().from(syncJobs)).toHaveLength(0);
  });
});
