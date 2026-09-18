import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches, eventPlanEntries, eventPlans, playerAliases, playerClaims, players, tournamentParticipants, tournaments, user, type Db } from '@smashclub/db';
import { mergePlayers } from '../src/players/merge';
import { createTestDb } from './helpers/testDb';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

async function fixture() {
  const [from, into] = await db.insert(players).values([{ canonicalName: 'Duplicate' }, { canonicalName: 'Original' }]).returning();
  await db.insert(user).values({ id: 'claimant', name: 'Claimant', email: 'claimant@example.test' });
  await db.insert(playerClaims).values({ userId: 'claimant', playerId: from!.id, status: 'approved' });
  await db.insert(playerAliases).values({ playerId: from!.id, aliasNorm: 'duplicate-alias', source: 'manual' });
  const [tournament] = await db.insert(tournaments).values({ name: 'Past event', challongeSlug: 'past' }).returning();
  await db.insert(tournamentParticipants).values({ tournamentId: tournament!.id, challongeParticipantId: 1, rawName: 'Duplicate', cleanedName: 'Duplicate', playerId: from!.id });
  return { from: from!, into: into! };
}

it.each(['roster_frozen', 'pools_ready', 'underway'] as const)('blocks source and destination entrants in %s before any identity writes', async (status) => {
  const { from, into } = await fixture();
  const [plan] = await db.insert(eventPlans).values({ name: 'Friday Nemesis', eventDate: new Date(), status }).returning();
  const [entry] = await db.insert(eventPlanEntries).values({ eventPlanId: plan!.id, sourceLineNumber: 1, rawInput: 'Entrant', cleanedName: 'Entrant', playerId: from.id }).returning();
  for (const playerId of [from.id, into.id]) {
    await db.update(eventPlanEntries).set({ playerId }).where(eq(eventPlanEntries.id, entry!.id));
    await expect(mergePlayers(db, from.id, into.id)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Friday Nemesis') });
    expect((await db.select().from(players).where(eq(players.id, from.id)))[0]!.status).toBe('active');
    expect((await db.select().from(playerAliases))[0]!.playerId).toBe(from.id);
    expect((await db.select().from(playerClaims))[0]!.playerId).toBe(from.id);
    expect((await db.select().from(tournamentParticipants))[0]!.playerId).toBe(from.id);
  }
});

it('also protects imported match participants outside the roster', async () => {
  const { from, into } = await fixture();
  const [plan] = await db.insert(eventPlans).values({ name: 'Imported event', eventDate: new Date(), status: 'underway' }).returning();
  await db.insert(eventMatches).values({ eventPlanId: plan!.id, sourceKey: 'imported', division: 'upper', stage: 'main', label: 'Final', player2Id: into.id });
  await expect(mergePlayers(db, from.id, into.id)).rejects.toMatchObject({ code: 'CONFLICT' });
});

it.each(['draft', 'complete', 'cancelled'] as const)('preserves normal identity merging for a %s event', async (status) => {
  const { from, into } = await fixture();
  const [plan] = await db.insert(eventPlans).values({ name: 'Inactive event', eventDate: new Date(), status }).returning();
  await db.insert(eventPlanEntries).values({ eventPlanId: plan!.id, sourceLineNumber: 1, rawInput: 'Duplicate', cleanedName: 'Duplicate', playerId: from.id });
  await mergePlayers(db, from.id, into.id);
  expect((await db.select().from(players).where(eq(players.id, from.id)))[0]!.mergedIntoPlayerId).toBe(into.id);
  expect((await db.select().from(playerClaims))[0]!.playerId).toBe(into.id);
  expect((await db.select().from(tournamentParticipants))[0]!.playerId).toBe(into.id);
});
