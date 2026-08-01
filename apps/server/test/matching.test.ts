import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  identityDecisions,
  playerAliases,
  players,
  reviewItems,
  tournamentParticipants,
  tournaments,
  type Db,
} from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'josh-cortese', canonical_name: 'Josh Cortese', company: 'ATL' },
    { id: 'jackson', canonical_name: 'Jackson Lin', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ['weekly1']);
});

afterEach(async () => {
  await close();
});

async function syncWithParticipants(names: string[]): Promise<void> {
  const fixture: FixtureTournament = {
    slug: 'weekly1',
    state: 'complete',
    participants: names.map((name, index) => ({ id: index + 1, name })),
    matches:
      names.length >= 2
        ? [{ id: 11, p1: 1, p2: 2, winner: 1, order: 1 }]
        : [],
  };
  const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, 'weekly1'));
  await syncTournament(db, fixtureClient([fixture]), row!.id);
}

describe('participant matching pipeline', () => {
  it('auto-links structured short forms when unambiguous (Josh C -> Josh Cortese)', async () => {
    await syncWithParticipants(['[ATL] Josh C', '[ATL] Jackson Lin']);
    const rows = await db.select().from(tournamentParticipants);
    const joshC = rows.find((r) => r.rawName === '[ATL] Josh C')!;
    const [cortese] = await db.select().from(players).where(eq(players.legacyId, 'josh-cortese'));
    expect(joshC.playerId).toBe(cortese!.id);
    expect(await db.select().from(reviewItems)).toHaveLength(0);
  });

  it('does not turn a structured short form into a durable alias', async () => {
    await syncWithParticipants(['[ATL] Josh C', '[ATL] Jackson Lin']);
    // The link is an inference from today's pool, not a club record: writing it
    // to player_aliases would keep resolving it silently once a second Josh C.
    // exists. Only registry/manual/decision sources mint aliases.
    const aliases = await db.select().from(playerAliases).where(eq(playerAliases.aliasNorm, 'josh c'));
    expect(aliases).toHaveLength(0);
  });

  it('re-routes a short form to review once the pool makes it ambiguous', async () => {
    await syncWithParticipants(['[ATL] Josh C', '[ATL] Jackson Lin']);
    expect(await db.select().from(reviewItems)).toHaveLength(0);

    // A second matching Josh joins the club, so "Josh C" stops being provable.
    await importRegistryPlayers(db, [{ id: 'josh-chen', canonical_name: 'Josh Chen', company: 'ATL' }]);
    await registerTournamentSlugs(db, ['weekly2']);
    const fixture: FixtureTournament = {
      slug: 'weekly2',
      state: 'complete',
      participants: [
        { id: 1, name: '[ATL] Josh C' },
        { id: 2, name: '[ATL] Jackson Lin' },
      ],
      matches: [{ id: 11, p1: 1, p2: 2, winner: 1, order: 1 }],
    };
    const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, 'weekly2'));
    await syncTournament(db, fixtureClient([fixture]), row!.id);

    const queue = await db.select().from(reviewItems);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.cleanedName).toBe('Josh C');
  });

  it('never fuzzy-merges: near-miss names go to the review queue with candidates', async () => {
    await syncWithParticipants(['[ATL] Josh Cortesse', '[ATL] Jackson Lin']); // typo'd surname
    const rows = await db.select().from(tournamentParticipants);
    expect(rows.find((r) => r.rawName === '[ATL] Josh Cortesse')!.playerId).toBeNull();

    const queue = await db.select().from(reviewItems);
    expect(queue).toHaveLength(1);
    const candidates = queue[0]!.candidates as Array<{ name: string; score: number; reason: string }>;
    expect(candidates.some((c) => c.name === 'Josh Cortese')).toBe(true);
  });

  it('applies a prior merge decision silently on the next sync', async () => {
    const [cortese] = await db.select().from(players).where(eq(players.legacyId, 'josh-cortese'));
    await db.insert(identityDecisions).values({
      kind: 'merge',
      aliasNorm: 'j-money',
      companyId: null,
      playerId: cortese!.id,
    });

    await syncWithParticipants(['J-Money', '[ATL] Jackson Lin']);
    const rows = await db.select().from(tournamentParticipants);
    expect(rows.find((r) => r.rawName === 'J-Money')!.playerId).toBe(cortese!.id);
    expect(await db.select().from(reviewItems)).toHaveLength(0);
  });

  it('filters kept-separate candidates out of the review queue', async () => {
    const [jacksonLin] = await db.select().from(players).where(eq(players.legacyId, 'jackson'));
    // The club decided long ago: "Jackson Chen" is NOT Jackson Lin.
    await db.insert(identityDecisions).values({
      kind: 'keep_separate',
      aliasNorm: 'jackson chen',
      companyId: null,
      keptSeparateFromPlayerId: jacksonLin!.id,
    });

    await syncWithParticipants(['[ATL] Jackson Chen', '[ATL] Josh Cortese']);
    const queue = await db.select().from(reviewItems);
    expect(queue).toHaveLength(1);
    const candidates = queue[0]!.candidates as Array<{ playerId: string }>;
    expect(candidates.some((c) => c.playerId === jacksonLin!.id)).toBe(false);
  });

  it('does not duplicate pending review items across syncs', async () => {
    await syncWithParticipants(['Falco Lombardi', '[ATL] Jackson Lin']);
    await syncWithParticipants(['Falco Lombardi', '[ATL] Jackson Lin']);
    expect(await db.select().from(reviewItems)).toHaveLength(1);
  });
});

describe('importRegistryPlayers idempotency', () => {
  it('re-running the import updates instead of duplicating', async () => {
    const again = await importRegistryPlayers(db, [
      { id: 'josh-cortese', canonical_name: 'Josh Cortese', company: 'ATL' },
      { id: 'new-player', canonical_name: 'Peppy Hare', company: 'GOOG', aliases: ['Peppy'] },
    ]);
    // Josh is byte-identical to the first import, so he is *unchanged* rather
    // than rewritten — re-importing the registry is a no-op for everyone the
    // file did not actually change.
    expect(again.unchanged).toBe(1);
    expect(again.updated).toBe(0);
    expect(again.created).toBe(1);
    const allPlayers = await db.select().from(players);
    expect(allPlayers).toHaveLength(3);
  });
});
